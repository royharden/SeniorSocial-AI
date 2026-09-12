import { ConsentConflict } from './index.ts';
import { scopeRules } from './types.ts';
import type { ConsentStore } from './types.ts';

/** Adapter over a transaction's parameterized query method (e.g. postgres unsafe). */
export interface PolicySql {
  query<T extends Record<string, unknown>>(text: string, values: readonly (string | number | null)[]): Promise<T[]>;
}
/** Must create a fresh READ COMMITTED transaction, bind app.current_org_id
 * transaction-locally, commit before resolving, and rollback/release on errors.
 * Use packages/db withOrg with the non-owner seniorsocial_app runtime role.
 */
export type OrgTransaction = <T>(orgId: string, work: (sql: PolicySql) => Promise<T>) => Promise<T>;

export function createConsentRepository(withOrg: OrgTransaction): ConsentStore {
  return {
    hasActiveScope: key => withOrg(key.orgId, async sql => {
      const rows = await sql.query<{ allowed: boolean }>(`
        select exists (
          select 1 from consent_scopes s
          join caregiver_links l on l.org_id = s.org_id and l.id = s.link_id
          join users resident on resident.org_id = s.org_id and resident.id = s.granted_by
          join users caregiver on caregiver.org_id = s.org_id and caregiver.id = s.granted_to
          where s.org_id = $1 and s.granted_by = $2 and s.granted_to = $3 and s.scope = $4
            and s.revoked_at is null and s.read_back_confirmed_at is not null
            and (s.expires_at is null or s.expires_at > statement_timestamp())
            and resident.account_state = 'active' and caregiver.account_state = 'active'
        ) as allowed`, [key.orgId, key.residentId, key.caregiverId, key.scope]);
      return rows[0]?.allowed === true;
    }),
    change: mutation => withOrg(mutation.orgId, async sql => {
      const { orgId, residentId, caregiverId, scope, entryActorId, decisionActorId, operation } = mutation;
      const participants = await sql.query<{ valid: boolean }>(`
        select exists (
          select 1 from users r join user_roles rr on rr.org_id = r.org_id and rr.user_id = r.id
          join users c on c.org_id = r.org_id
          join user_roles cr on cr.org_id = c.org_id and cr.user_id = c.id
          where r.org_id = $1 and r.id = $2 and c.id = $3
            and rr.role = 'senior' and cr.role = 'caregiver'
            and r.account_state = 'active' and c.account_state = 'active'
        ) as valid`, [orgId, residentId, caregiverId]);
      if (!participants[0]?.valid) throw new ConsentConflict();
      await sql.query(`insert into caregiver_links (org_id, resident_id, caregiver_id)
        values ($1, $2, $3) on conflict (org_id, resident_id, caregiver_id) do nothing`,
      [orgId, residentId, caregiverId]);
      const links = await sql.query<{ id: string; version: number }>(`
        select id, version from caregiver_links
        where org_id = $1 and resident_id = $2 and caregiver_id = $3 for update`,
      [orgId, residentId, caregiverId]);
      const link = links[0];
      if (!link || link.version !== mutation.expectedVersion) throw new ConsentConflict();
      const existing = await sql.query<{ id: string }>(`
        select id from consent_scopes
        where org_id = $1 and link_id = $2 and scope = $3 and revoked_at is null`, [orgId, link.id, scope]);
      if ((operation === 'grant' && existing.length > 0) || (operation === 'revoke' && existing.length !== 1)) {
        throw new ConsentConflict();
      }
      const history = await sql.query<{ id: string }>(`
        insert into consent_grants (org_id, link_id, scope, operation, entry_actor_id, decision_actor_id, version)
        values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [orgId, link.id, scope, operation, entryActorId, decisionActorId, link.version + 1]);
      const grantId = history[0]?.id;
      if (!grantId) throw new Error('Consent history write failed');
      let id = existing[0]?.id;
      if (operation === 'grant') {
        const rule = scopeRules[scope];
        const rows = await sql.query<{ id: string }>(`
          insert into consent_scopes (org_id, link_id, grant_id, granted_by, granted_to, scope,
            resource, action, entry_actor_id, decision_actor_id, read_back_confirmed_at, expires_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,statement_timestamp(),$11) returning id`,
        [orgId, link.id, grantId, residentId, caregiverId, scope, rule.resource, rule.action,
          entryActorId, decisionActorId, mutation.expiresAt?.toISOString() ?? null]);
        id = rows[0]?.id;
      } else {
        await sql.query(`update consent_scopes set revoked_at = statement_timestamp(), revocation_id = $4
          where org_id = $1 and link_id = $2 and scope = $3 and revoked_at is null`,
        [orgId, link.id, scope, grantId]);
      }
      if (!id) throw new Error('Consent scope write failed');
      await sql.query(`update caregiver_links set version = version + 1 where org_id = $1 and id = $2`, [orgId, link.id]);
      return { id, version: link.version + 1 };
    }),
    recordDecision: decision => withOrg(decision.orgId, async sql => {
      await sql.query(`insert into policy_decisions
        (org_id, entry_actor_id, decision_actor_id, outcome, reason) values ($1,$2,$3,$4,$5)`,
      [decision.orgId, decision.entryActorId, decision.decisionActorId, decision.outcome, decision.reason]);
    }),
  };
}
