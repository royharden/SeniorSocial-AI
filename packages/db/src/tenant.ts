import type postgres from 'postgres';
import type { DatabaseClient } from './client.ts';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type TenantTransaction = postgres.ReservedSql;

/**
 * Binds one transaction to the authenticated organisation. The caller must use
 * a non-owner database role; migration-owner connections are never application
 * connections. RLS provides the second enforcement layer beneath the explicit
 * org_id predicates used by repositories.
 */
export async function withOrg<T>(
  client: DatabaseClient,
  orgId: string,
  work: (transaction: TenantTransaction) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(orgId)) throw new Error('orgId must be a UUID');
  const transaction = await client.reserve();
  try {
    await transaction`begin`;
    await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
    const result = await work(transaction);
    await transaction`commit`;
    return result;
  } catch (error) {
    await transaction`rollback`;
    throw error;
  } finally {
    transaction.release();
  }
}

export async function findUserById(client: DatabaseClient, orgId: string, userId: string) {
  if (!uuidPattern.test(userId)) throw new Error('userId must be a UUID');
  return withOrg(client, orgId, async transaction => {
    const rows = await transaction<{
      id: string;
      org_id: string;
      display_name: string;
      account_state: string;
    }[]>`
      select id, org_id, display_name, account_state
      from users
      where org_id = ${orgId} and id = ${userId}
      limit 1
    `;
    return rows[0] ?? null;
  });
}
