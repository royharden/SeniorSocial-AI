import type { AuthSql } from './postgres-store';

interface RuntimeRoleRow extends Record<string, unknown> {
  role_name: string;
  can_login: boolean;
  is_superuser: boolean;
  bypasses_rls: boolean;
  owns_operational_table: boolean;
}

export async function assertConstrainedRuntimeRole(sql: AuthSql): Promise<void> {
  const rows = await sql<RuntimeRoleRow[]>`
    select current_user as role_name,
           r.rolcanlogin as can_login,
           r.rolsuper as is_superuser,
           r.rolbypassrls as bypasses_rls,
           exists (
             select 1
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relkind in ('r', 'p')
               and c.relname in (
                 'orgs', 'users', 'user_roles', 'profiles', 'service_categories', 'partners',
                 'verification_tokens', 'sessions', 'demo_accounts', 'recovery_contacts', 'auth_rate_limits'
               )
               and pg_get_userbyid(c.relowner) = current_user
           ) as owns_operational_table
    from pg_roles r where r.rolname = current_user
  `;
  const role = rows[0];
  if (!role?.can_login || role.is_superuser || role.bypasses_rls || role.owns_operational_table) {
    throw new Error('auth runtime requires a dedicated LOGIN role that cannot own or bypass operational RLS');
  }
}
