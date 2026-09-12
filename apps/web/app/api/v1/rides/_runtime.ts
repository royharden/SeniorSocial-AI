import { createAuthDatabaseClient, assertConstrainedRuntimeRole, type AuthSql } from '../../../../../../packages/auth/src/index';
import {
  createPostgresRideRepository,
  createRideService,
  type Actor,
  type RideSql,
  type RideState,
} from '../../../../../../packages/rides/src/index';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';
import type { RideHttpDependencies } from './_http';

type RuntimeClient = ReturnType<typeof createAuthDatabaseClient>;
let client: RuntimeClient | undefined;
function database(): RuntimeClient { return client ??= createAuthDatabaseClient(); }

export async function withRideRuntimeTransaction<T>(
  runtimeClient: RuntimeClient,
  orgId: string,
  work: (sql: RideSql) => Promise<T>,
): Promise<T> {
  return runtimeClient.begin(async sql => {
    await assertConstrainedRuntimeRole(sql as unknown as AuthSql);
    const adapter: RideSql = {
      query: async <Row extends Record<string, unknown>>(text: string, values: readonly (string | boolean | null)[]) =>
        await sql.unsafe<Row[]>(text, [...values]) as Row[],
    };
    await sql`select set_config('app.current_org_id', ${orgId}, true)`;
    return work(adapter);
  }) as Promise<T>;
}

async function transaction<T>(orgId: string, work: (sql: RideSql) => Promise<T>): Promise<T> {
  return withRideRuntimeTransaction(database(), orgId, work);
}

const repository = createPostgresRideRepository(transaction);
const authorization = {
  canRead: (actor: Actor, ride: { orgId: string; residentId: string }) => Promise.resolve(actor.orgId === ride.orgId &&
    (actor.id === ride.residentId || actor.roles.some(role => role === 'staff' || role === 'admin'))),
  canCreate: async (actor: Actor, residentId: string) => {
    if (actor.id === residentId && actor.roles.includes('senior')) return true;
    if (!actor.roles.includes('caregiver')) return false;
    return transaction(actor.orgId, async sql => {
      const rows = await sql.query<{ allowed: boolean }>(`select exists (
        select 1 from consent_scopes s
        join users resident on resident.org_id=s.org_id and resident.id=s.granted_by
        join users caregiver on caregiver.org_id=s.org_id and caregiver.id=s.granted_to
        where s.org_id=$1 and s.granted_by=$2 and s.granted_to=$3 and s.scope='book_rides'
          and s.revoked_at is null and s.read_back_confirmed_at is not null
          and (s.expires_at is null or s.expires_at>statement_timestamp())
          and resident.account_state='active' and caregiver.account_state='active'
      ) as allowed`, [actor.orgId, residentId, actor.id]);
      return rows[0]?.allowed === true;
    });
  },
  canListQueue: (actor: Actor) => Promise.resolve(actor.roles.some(role => role === 'staff' || role === 'admin')),
  canTransition: (actor: Actor, ride: { orgId: string; residentId: string }, to: RideState) => Promise.resolve(actor.orgId === ride.orgId &&
    (actor.roles.some(role => role === 'staff' || role === 'admin') || (actor.id === ride.residentId && to === 'cancelled'))),
};
const rides = createRideService({ repository, authorization, dispatch: {
  // Local queue acceptance only. This does not claim provider confirmation and
  // performs no external call; WP-009 may replace the injected port at composition.
  submit: payload => Promise.resolve({ outcome: 'accepted_for_review' as const, evidence: `local-queue:${payload.idempotencyKey}` }),
}, confirmation: {
  // No provider integration is authorized in this run. Staff input cannot
  // manufacture confirmation evidence, so confirmed_by remains unavailable.
  evidence: () => Promise.resolve(null),
}, events: {
  // Composition hook for the in-process event bus; audit facts are already
  // committed atomically by the repository.
  publish: () => Promise.resolve(),
}, jobs: {
  // WP-009 replaces this port with its pg-boss singleton bridge at integration.
  enqueue: () => Promise.resolve(),
} });

export const runtimeDependencies: RideHttpDependencies = {
  authorize: async request => {
    try {
      const orgId = configuredOrgId(request);
      const token = readCookie(request, SESSION_COOKIE);
      if (!token) return null;
      const session = await withAuthService(orgId, service => service.session(orgId, token));
      return session ? { id: session.userId, orgId: session.orgId, roles: session.roles } : null;
    } catch { return null; }
  },
  rides,
};
