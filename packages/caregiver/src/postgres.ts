import type postgres from 'postgres';
import type {
  AtomicAudit, CaregiverRepository, CaregiverScopeKey, CaregiverTransaction, ReadBackRecord,
  StoredInvitation, StoredLink, StoredScope,
} from './types.ts';

export type CaregiverPostgresFactory = typeof postgres;
type PostgresClient = ReturnType<CaregiverPostgresFactory>;
type Sql = postgres.ReservedSql;
export type CaregiverRuntimeRoleAssertion = (sql: Sql) => Promise<void>;
interface InvitationRow {
  id: string; org_id: string; resident_id: string; recipient_digest: string; token_digest: string;
  relationship_note: string | null;
  created_at: Date; expires_at: Date; accepted_at: Date | null; caregiver_id: string | null;
}
interface LinkRow { id: string; org_id: string; resident_id: string; caregiver_id: string; state: StoredLink['state']; version: number }
interface ScopeRow { scope: CaregiverScopeKey; granted_at: Date; revoked_at: Date | null }

const invitation = (row: InvitationRow): StoredInvitation => ({ id: row.id, orgId: row.org_id, residentId: row.resident_id,
  recipientDigest: row.recipient_digest, tokenDigest: row.token_digest,
  relationshipNote: row.relationship_note,
  createdAt: row.created_at, expiresAt: row.expires_at, acceptedAt: row.accepted_at, caregiverId: row.caregiver_id });

async function scopes(sql: Sql, orgId: string, linkId: string): Promise<StoredScope[]> {
  const rows = await sql<ScopeRow[]>`select scope, granted_at, revoked_at from consent_scopes
    where org_id = ${orgId} and link_id = ${linkId} order by granted_at, id`;
  return rows.map(row => ({ key: row.scope, grantedAt: row.granted_at, revokedAt: row.revoked_at }));
}
async function link(sql: Sql, orgId: string, linkId: string, lock = false): Promise<(StoredLink & { version: number }) | null> {
  const rows = lock
    ? await sql<LinkRow[]>`select id, org_id, resident_id, caregiver_id, state, version from caregiver_links
        where org_id = ${orgId} and id = ${linkId} for update`
    : await sql<LinkRow[]>`select id, org_id, resident_id, caregiver_id, state, version from caregiver_links
        where org_id = ${orgId} and id = ${linkId}`;
  const row = rows[0]; if (!row) return null;
  return { id: row.id, orgId: row.org_id, residentId: row.resident_id, caregiverId: row.caregiver_id,
    state: row.state, version: row.version, scopes: await scopes(sql, orgId, row.id) };
}

async function changeScope(sql: Sql, current: StoredLink & { version: number }, key: CaregiverScopeKey,
  operation: 'grant' | 'revoke', at: Date, finalState: StoredLink['state']): Promise<void> {
  const version = current.version + 1;
  const history = await sql<{ id: string }[]>`insert into consent_grants
    (org_id, link_id, scope, operation, entry_actor_id, decision_actor_id, version, at)
    values (${current.orgId}, ${current.id}, ${key}, ${operation}, ${current.residentId}, ${current.residentId}, ${version}, ${at}) returning id`;
  const historyId = history[0]?.id; if (!historyId) throw new Error('Consent history write failed');
  if (operation === 'grant') {
    const rule = ({ view_schedule: ['schedule', 'read'], book_rides: ['ride', 'book'], receive_alerts: ['alert', 'read'],
      view_assistance: ['assistance', 'read'], manage_events: ['event', 'manage'], view_profile: ['profile', 'read'] } as const)[key];
    await sql`insert into consent_scopes (org_id, link_id, grant_id, granted_by, granted_to, scope, resource, action,
      entry_actor_id, decision_actor_id, granted_at, read_back_confirmed_at)
      values (${current.orgId}, ${current.id}, ${historyId}, ${current.residentId}, ${current.caregiverId}, ${key},
        ${rule[0]}, ${rule[1]}, ${current.residentId}, ${current.residentId}, ${at}, ${at})`;
  } else {
    await sql`update consent_scopes set revoked_at = ${at}, revocation_id = ${historyId}
      where org_id = ${current.orgId} and link_id = ${current.id} and scope = ${key} and revoked_at is null`;
  }
  await sql`update caregiver_links set version = ${version}, state = ${finalState}
    where org_id = ${current.orgId} and id = ${current.id}`;
  current.version = version; current.state = finalState;
}

function transactionAdapter(sql: Sql, orgId: string): CaregiverTransaction {
  return {
    async insertInvitation(value) {
      await sql`insert into caregiver_invitations (id, org_id, resident_id, recipient_digest, token_digest,
        relationship_note, created_at, expires_at) values (${value.id}, ${orgId}, ${value.residentId},
        ${value.recipientDigest}, ${value.tokenDigest}, ${value.relationshipNote}, ${value.createdAt}, ${value.expiresAt})`;
    },
    async invitationByTokenDigest(tokenDigest) {
      const rows = await sql<InvitationRow[]>`select id, org_id, resident_id, recipient_digest, token_digest,
        relationship_note, created_at, expires_at, accepted_at, caregiver_id from caregiver_invitations
        where org_id = ${orgId} and token_digest = ${tokenDigest} for update`;
      return rows[0] ? invitation(rows[0]) : null;
    },
    async acceptInvitation(invitationId, caregiverId, linkId, at) {
      const accepted = await sql<{ resident_id: string }[]>`update caregiver_invitations
        set accepted_at = ${at}, caregiver_id = ${caregiverId}
        where org_id = ${orgId} and id = ${invitationId} and accepted_at is null returning resident_id`;
      const residentId = accepted[0]?.resident_id; if (!residentId) throw new Error('Invitation acceptance conflict');
      const rows = await sql<LinkRow[]>`insert into caregiver_links (id, org_id, resident_id, caregiver_id, state)
        values (${linkId}, ${orgId}, ${residentId}, ${caregiverId}, 'pending')
        returning id, org_id, resident_id, caregiver_id, state, version`;
      const row = rows[0]; if (!row) throw new Error('Caregiver link write failed');
      return { id: row.id, orgId: row.org_id, residentId: row.resident_id, caregiverId: row.caregiver_id,
        state: row.state, scopes: [] };
    },
    async linkById(linkId) { const found = await link(sql, orgId, linkId); if (!found) return null; const { version: _version, ...value } = found; return value; },
    async linksForCaregiver(caregiverId) {
      const rows = await sql<LinkRow[]>`select id, org_id, resident_id, caregiver_id, state, version from caregiver_links
        where org_id = ${orgId} and caregiver_id = ${caregiverId} order by created_at, id`;
      return Promise.all(rows.map(async row => ({ id: row.id, orgId: row.org_id, residentId: row.resident_id,
        caregiverId: row.caregiver_id, state: row.state, scopes: await scopes(sql, orgId, row.id) })));
    },
    async linksForResident(residentId) {
      const rows = await sql<LinkRow[]>`select id, org_id, resident_id, caregiver_id, state, version from caregiver_links
        where org_id = ${orgId} and resident_id = ${residentId} order by created_at, id`;
      return Promise.all(rows.map(async row => ({ id: row.id, orgId: row.org_id, residentId: row.resident_id,
        caregiverId: row.caregiver_id, state: row.state, scopes: await scopes(sql, orgId, row.id) })));
    },
    async accountRecipients(userId) {
      const rows = await sql<{ email: string | null; phone: string | null }[]>`select email::text, phone from users
        where org_id = ${orgId} and id = ${userId} and account_state = 'active' limit 1`;
      const row = rows[0]; return row ? [row.email, row.phone].filter((value): value is string => value !== null) : [];
    },
    async replaceScopes(linkId, desiredKeys, at) {
      const current = await link(sql, orgId, linkId, true); if (!current) throw new Error('Caregiver link disappeared');
      const desired = new Set(desiredKeys); const active = new Set(current.scopes.filter(item => item.revokedAt === null).map(item => item.key));
      const changes: [CaregiverScopeKey, 'grant' | 'revoke'][] = [
        ...[...active].filter(key => !desired.has(key)).map<[CaregiverScopeKey, 'revoke']>(key => [key, 'revoke']),
        ...[...desired].filter(key => !active.has(key)).map<[CaregiverScopeKey, 'grant']>(key => [key, 'grant']),
      ];
      const finalState = desired.size > 0 ? 'active' : 'pending';
      for (const [key, operation] of changes) await changeScope(sql, current, key, operation, at, finalState);
      const refreshed = await link(sql, orgId, linkId); if (!refreshed) throw new Error('Caregiver link disappeared');
      const { version: _version, ...value } = refreshed; return value;
    },
    async revokeLink(linkId, at) {
      const current = await link(sql, orgId, linkId, true); if (!current) throw new Error('Caregiver link disappeared');
      const active = current.scopes.filter(item => item.revokedAt === null);
      for (const [index, scope] of active.entries()) await changeScope(sql, current, scope.key, 'revoke', at,
        index === active.length - 1 ? 'revoked' : current.state);
      if (active.length === 0) await sql`update caregiver_links set state = 'revoked'
        where org_id = ${orgId} and id = ${linkId}`;
      const refreshed = await link(sql, orgId, linkId); if (!refreshed) throw new Error('Caregiver link disappeared');
      const { version: _version, ...value } = refreshed; return value;
    },
    async appendReadBack(record: ReadBackRecord) {
      await sql`insert into consent_read_backs (org_id, link_id, resident_id, entry_actor_id, scopes, confirmed_at)
        values (${orgId}, ${record.linkId}, ${record.residentId}, ${record.actorId}, ${record.scopes}, ${record.confirmedAt})`;
    },
    async appendAudit(event: AtomicAudit) {
      const reason = `reason=${event.reason};grantor=${event.grantorId};caregiver=${event.caregiverId ?? 'none'};resource=${event.resource};action=${event.resourceAction};actor=${event.actorId}`;
      const target = event.resource.includes(':') ? event.resource : `${event.resource}:${event.resourceAction}`;
      await sql`insert into audit_events (actor, on_behalf_of, action, target, org_id, outcome, reason, fields)
        values (${`user:${event.actorId}`}, ${event.actorId === event.grantorId ? null : `user:${event.grantorId}`},
          ${event.action}, ${target}, ${orgId}, ${event.outcome}, ${reason},
          ${['action', 'actor_id', 'caregiver_id', 'grantor_id', 'resource']})`;
    },
  };
}

/** Real WP-003 transaction shape: non-owner client, tenant-local RLS binding, fresh READ COMMITTED view. */
export class PostgresCaregiverRepository implements CaregiverRepository {
  constructor(private readonly client: PostgresClient, private readonly assertRuntimeRole: CaregiverRuntimeRoleAssertion) {}
  async transaction<T>(orgId: string, work: (transaction: CaregiverTransaction) => Promise<T>): Promise<T> {
    const sql = await this.client.reserve();
    try {
      await sql`begin isolation level read committed`;
      await this.assertRuntimeRole(sql);
      await sql`select set_config('app.current_org_id', ${orgId}, true)`;
      const result = await work(transactionAdapter(sql, orgId));
      await sql`commit`; return result;
    } catch (error) { await sql`rollback`; throw error; }
    finally { sql.release(); }
  }
}
