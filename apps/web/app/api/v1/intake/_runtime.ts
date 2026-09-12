import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';
import { createAuthDatabaseClient, assertConstrainedRuntimeRole, type AuthSql } from '../../../../../../packages/auth/src/index';
import { createIntakeNarrativeCipher, createIntakeService, createPostgresIntakeRepository,
  type Actor, type IntakeSql, type NarrativeCipher } from '@seniorsocial/intake';
import type { IntakeHttpDependencies } from './_http';

type RuntimeClient = ReturnType<typeof createAuthDatabaseClient>;
let client: RuntimeClient | undefined;
function database(): RuntimeClient { return client ??= createAuthDatabaseClient(); }
export async function withIntakeRuntimeTransaction<T>(
  runtimeClient: RuntimeClient,
  orgId: string,
  work: (sql: IntakeSql) => Promise<T>,
): Promise<T> {
  return runtimeClient.begin(async sql => {
    await assertConstrainedRuntimeRole(sql as unknown as AuthSql);
    const adapter: IntakeSql = { query: async <Row extends Record<string, unknown>>(text: string, values: readonly (string | boolean | null)[]) =>
      await sql.unsafe<Row[]>(text, [...values]) as Row[] };
    await sql`select set_config('app.current_org_id',${orgId},true)`;
    return work(adapter);
  }) as Promise<T>;
}
async function transaction<T>(orgId: string, work: (sql: IntakeSql) => Promise<T>): Promise<T> {
  return withIntakeRuntimeTransaction(database(), orgId, work);
}
let cipher: NarrativeCipher | undefined;
function narrativeCipher(): NarrativeCipher { return cipher ??= createIntakeNarrativeCipher(process.env.FIELD_ENCRYPTION_KEY); }
const repository = createPostgresIntakeRepository(transaction, narrativeCipher);
const intake = createIntakeService({ repository, authorization: {
  canManage: (actor: Actor, residentId: string) => Promise.resolve(actor.id === residentId && actor.roles.includes('senior')),
} });

export const runtimeDependencies: IntakeHttpDependencies = {
  authorize: async request => {
    try {
      const orgId = configuredOrgId(request); const token = readCookie(request, SESSION_COOKIE); if (!token) return null;
      const session = await withAuthService(orgId, service => service.session(orgId, token));
      return session ? { id: session.userId, orgId: session.orgId, roles: session.roles } : null;
    } catch { return null; }
  },
  intake,
};
