import { PostgresAuthStore, type AuthSql } from './postgres-store';
import { assertConstrainedRuntimeRole } from './runtime-role';
import { AuthService } from './service';
import { authRoleValues, type AuthRole } from './types';

export interface DemoBootstrapInput {
  orgId: string;
  userId: string;
  code: string;
  expiresAt: Date;
}

export interface AuthBeginClient {
  begin<T>(work: (transaction: AuthSql) => Promise<T>): Promise<T>;
}

export async function bootstrapDemoAccounts(
  client: AuthBeginClient,
  inputs: DemoBootstrapInput[],
  pepper: string,
): Promise<number> {
  if (inputs.length === 0) throw new Error('demo account input must be non-empty');
  return client.begin(async transaction => {
    await assertConstrainedRuntimeRole(transaction);
    const coverage = new Map<string, Set<AuthRole>>();

    // Validate every org and user before the first write; any failure aborts the one transaction.
    for (const input of inputs) {
      if (input.code.length < 6 || input.expiresAt <= new Date()) throw new Error('demo code expiry must be in the future');
      await transaction`select set_config('app.current_org_id', ${input.orgId}, true)`;
      const users = await transaction<{ account_state: string; is_demo: boolean; roles: AuthRole[] }[]>`
        select u.account_state, u.is_demo,
          coalesce(array_agg(ur.role) filter (where ur.role is not null), '{}')::text[] as roles
        from users u left join user_roles ur on ur.org_id = u.org_id and ur.user_id = u.id
        where u.org_id = ${input.orgId} and u.id = ${input.userId}
        group by u.id limit 1
      `;
      const user = users[0];
      if (!user?.is_demo || user.account_state !== 'active') {
        throw new Error('demo bootstrap requires active synthetic demo users');
      }
      const roles = coverage.get(input.orgId) ?? new Set<AuthRole>();
      for (const role of user.roles) roles.add(role);
      coverage.set(input.orgId, roles);
    }
    for (const [orgId, roles] of coverage) {
      const missing = authRoleValues.filter(role => !roles.has(role));
      if (missing.length > 0) throw new Error(`demo bootstrap org ${orgId} lacks roles: ${missing.join(', ')}`);
    }

    const service = new AuthService(new PostgresAuthStore(transaction), { pepper });
    for (const input of inputs) {
      await transaction`select set_config('app.current_org_id', ${input.orgId}, true)`;
      await service.bootstrapDemoAccount(input);
    }
    return inputs.length;
  });
}

export function parseDemoBootstrapInputs(source: string): DemoBootstrapInput[] {
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed)) throw new Error('demo account input must be an array');
  return parsed.map(value => {
    if (!value || typeof value !== 'object') throw new Error('invalid demo account input');
    const row = value as Record<string, unknown>;
    if (typeof row.orgId !== 'string' || typeof row.userId !== 'string'
      || typeof row.code !== 'string' || typeof row.expiresAt !== 'string') {
      throw new Error('each demo account needs orgId, userId, code, and expiresAt');
    }
    const expiresAt = new Date(row.expiresAt);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error('invalid demo expiry');
    return { orgId: row.orgId, userId: row.userId, code: row.code, expiresAt };
  });
}
