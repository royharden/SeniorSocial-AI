import type postgres from 'postgres';
import { createConsentRepository } from './repository.ts';
import type { OrgTransaction } from './repository.ts';

export type PostgresFactory = typeof postgres;
export type PolicyDatabase = ReturnType<typeof postgres>;

/** Same reserve/bind/commit/release pattern as packages/db withOrg, with an
 * explicit READ COMMITTED snapshot so a prior scope cannot survive revocation.
 * Caller must supply the non-owner, non-BYPASSRLS runtime connection.
 */
export function postgresOrgTransaction(client: PolicyDatabase): OrgTransaction {
  return async (orgId, work) => {
    const transaction = await client.reserve();
    try {
      await transaction`begin isolation level read committed`;
      await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
      const result = await work({ query: async <T extends Record<string, unknown>>(
        text: string, values: readonly (string | number | null)[],
      ) => Array.from(await transaction.unsafe<T[]>(text, [...values])) });
      await transaction`commit`;
      return result;
    } catch (error) {
      await transaction`rollback`;
      throw error;
    } finally { transaction.release(); }
  };
}

export function createPostgresConsentRepository(client: PolicyDatabase) {
  return createConsentRepository(postgresOrgTransaction(client));
}
