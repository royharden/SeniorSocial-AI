import type {
  AuthResult,
  AuthRole,
  AuthStore,
  AuthUser,
  DemoAccountInput,
  NewSession,
  NewVerification,
  RateLimitDecision,
  RateLimitIncrement,
  SessionRecord,
  VerificationMethod,
} from './types';

export interface AuthSql {
  <T extends readonly Record<string, unknown>[] = readonly Record<string, unknown>[]>(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<T>;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  account_state: AuthUser['accountState'];
  is_demo: boolean;
  roles: AuthRole[];
}

function toUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    orgId: row.org_id,
    accountState: row.account_state,
    isDemo: row.is_demo,
    roles: row.roles,
  };
}

export class PostgresAuthStore implements AuthStore {
  readonly #sql: AuthSql;

  constructor(sql: AuthSql) {
    this.#sql = sql;
  }

  async findUserByIdentifier(orgId: string, method: VerificationMethod, identifier: string): Promise<AuthUser | null> {
    const rows = await this.#sql<UserRow[]>`
      select u.id, u.org_id, u.account_state, u.is_demo,
             coalesce(array_agg(ur.role) filter (where ur.role is not null), '{}')::text[] as roles
      from users u
      left join user_roles ur on ur.org_id = u.org_id and ur.user_id = u.id
      where u.org_id = ${orgId}
        and ((${method} = 'magic_link' and u.email = ${identifier})
          or (${method} = 'sms_code' and u.phone = ${identifier}))
      group by u.id, u.org_id
      limit 1
    `;
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  async createVerification(input: NewVerification): Promise<void> {
    await this.#sql`
      with invalidated as (
        update verification_tokens
        set consumed_at = now()
        where org_id = ${input.orgId} and user_id = ${input.userId}
          and method = ${input.method}::auth_verification_method and consumed_at is null
      )
      insert into verification_tokens
        (org_id, user_id, method, token_digest, browser_nonce_digest, expires_at)
      values
        (${input.orgId}, ${input.userId}, ${input.method}::auth_verification_method,
         ${input.credentialDigest}, ${input.browserNonceDigest}, ${input.expiresAt})
    `;
  }

  async consumeVerification(input: {
    orgId: string;
    method: VerificationMethod | undefined;
    credentialDigest: string;
    browserNonceDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>> {
    const rows = await this.#sql<(UserRow & { outcome: string })[]>`
      with candidate as materialized (
        select id, user_id, org_id, token_digest, browser_nonce_digest
        from verification_tokens
        where org_id = ${input.orgId}
          and (${input.method ?? null}::auth_verification_method is null
            or method = ${input.method ?? null}::auth_verification_method)
          and consumed_at is null and expires_at > ${input.now} and failed_attempts < 5
          and (token_digest = ${input.credentialDigest} or browser_nonce_digest = ${input.browserNonceDigest})
        order by (token_digest = ${input.credentialDigest}) desc, created_at desc
        limit 1 for update
      ), attempted as (
        update verification_tokens vt
        set failed_attempts = case
              when c.token_digest = ${input.credentialDigest}
               and c.browser_nonce_digest = ${input.browserNonceDigest} then failed_attempts
              else least(5, failed_attempts + 1)
            end,
            consumed_at = case
              when c.token_digest = ${input.credentialDigest}
               and c.browser_nonce_digest = ${input.browserNonceDigest} then ${input.now}
              when failed_attempts + 1 >= 5 then ${input.now}
              else consumed_at
            end
        from candidate c where vt.id = c.id
        returning vt.user_id, vt.org_id,
          case when c.token_digest = ${input.credentialDigest}
                 and c.browser_nonce_digest = ${input.browserNonceDigest}
               then 'consumed'
               when c.token_digest = ${input.credentialDigest} then 'wrong_device'
               else 'invalid' end as outcome
      )
      select u.id, u.org_id, u.account_state, u.is_demo, a.outcome,
             coalesce(array_agg(ur.role) filter (where ur.role is not null), '{}')::text[] as roles
      from attempted a
      join users u on u.org_id = a.org_id and u.id = a.user_id
      left join user_roles ur on ur.org_id = u.org_id and ur.user_id = u.id
      group by u.id, u.org_id, a.outcome
    `;
    const row = rows[0];
    if (!row) return { ok: false, reason: 'invalid_or_expired' };
    if (row.outcome === 'wrong_device') return { ok: false, reason: 'wrong_device' };
    if (row.outcome !== 'consumed') return { ok: false, reason: 'invalid_or_expired' };
    if (row.account_state !== 'active') return { ok: false, reason: 'account_inactive' };
    return { ok: true, value: toUser(row) };
  }

  async consumeDemoAccount(input: {
    orgId: string;
    codeDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>> {
    const rows = await this.#sql<UserRow[]>`
      with consumed as (
        update demo_accounts
        set used_at = ${input.now}
        where org_id = ${input.orgId} and code_digest = ${input.codeDigest}
          and used_at is null and expires_at > ${input.now}
        returning user_id, org_id
      )
      select u.id, u.org_id, u.account_state, u.is_demo,
             coalesce(array_agg(ur.role) filter (where ur.role is not null), '{}')::text[] as roles
      from consumed c
      join users u on u.org_id = c.org_id and u.id = c.user_id and u.is_demo = true
      left join user_roles ur on ur.org_id = u.org_id and ur.user_id = u.id
      group by u.id, u.org_id
    `;
    const row = rows[0];
    if (!row) {
      const expired = await this.#sql<{ expired: boolean }[]>`
        select exists(
          select 1 from demo_accounts
          where org_id = ${input.orgId} and code_digest = ${input.codeDigest} and expires_at <= ${input.now}
        ) as expired
      `;
      return { ok: false, reason: expired[0]?.expired ? 'demo_expired' : 'invalid_or_expired' };
    }
    if (row.account_state !== 'active') return { ok: false, reason: 'account_inactive' };
    return { ok: true, value: toUser(row) };
  }

  async createDemoAccount(input: DemoAccountInput): Promise<void> {
    await this.#sql`
      insert into demo_accounts (org_id, user_id, code_digest, expires_at)
      values (${input.orgId}, ${input.userId}, ${input.codeDigest}, ${input.expiresAt})
      on conflict (org_id, user_id) do update
      set code_digest = excluded.code_digest, expires_at = excluded.expires_at, used_at = null
    `;
  }

  async createSession(input: NewSession): Promise<void> {
    await this.#sql`
      insert into sessions (org_id, user_id, token_digest, expires_at, is_demo)
      values (${input.orgId}, ${input.userId}, ${input.tokenDigest}, ${input.expiresAt}, ${input.isDemo})
    `;
  }

  async findSession(orgId: string, tokenDigest: string, now: Date): Promise<SessionRecord | null> {
    const rows = await this.#sql<(UserRow & { expires_at: Date; session_is_demo: boolean })[]>`
      select u.id, u.org_id, u.account_state, u.is_demo, s.expires_at, s.is_demo as session_is_demo,
             coalesce(array_agg(ur.role) filter (where ur.role is not null), '{}')::text[] as roles
      from sessions s
      join users u on u.org_id = s.org_id and u.id = s.user_id
      left join user_roles ur on ur.org_id = u.org_id and ur.user_id = u.id
      where s.org_id = ${orgId} and s.token_digest = ${tokenDigest}
        and s.revoked_at is null and s.expires_at > ${now} and u.account_state = 'active'
      group by u.id, u.org_id, s.expires_at, s.is_demo
      limit 1
    `;
    const row = rows[0];
    return row ? {
      userId: row.id,
      orgId: row.org_id,
      roles: row.roles,
      expiresAt: row.expires_at,
      isDemo: row.session_is_demo,
    } : null;
  }

  async revokeSession(orgId: string, tokenDigest: string, now: Date): Promise<boolean> {
    const rows = await this.#sql<{ id: string }[]>`
      update sessions set revoked_at = ${now}
      where org_id = ${orgId} and token_digest = ${tokenDigest} and revoked_at is null
      returning id
    `;
    return rows.length === 1;
  }

  async incrementRateLimit(input: RateLimitIncrement): Promise<RateLimitDecision> {
    const rows = await this.#sql<{ count: number; retry_after_seconds: number }[]>`
      with cleanup as (
        delete from auth_rate_limits where ctid in (
          select ctid from auth_rate_limits
          where window_started_at < ${new Date(input.now.getTime() - 24 * 60 * 60 * 1000)}
          limit 100
        )
      ), incremented as (
        insert into auth_rate_limits (org_id, purpose, subject_digest, window_started_at, count)
        values (${input.orgId}, ${input.purpose}::auth_rate_limit_purpose, ${input.subjectDigest}, ${input.now}, 1)
        on conflict (org_id, purpose, subject_digest) do update
        set count = case
              when auth_rate_limits.window_started_at + make_interval(secs => ${input.windowSeconds}) <= ${input.now}
                then 1 else auth_rate_limits.count + 1 end,
            window_started_at = case
              when auth_rate_limits.window_started_at + make_interval(secs => ${input.windowSeconds}) <= ${input.now}
                then ${input.now} else auth_rate_limits.window_started_at end
        returning count, greatest(0, ceil(extract(epoch from
          (window_started_at + make_interval(secs => ${input.windowSeconds}) - ${input.now}))))::integer
          as retry_after_seconds
      ) select count, retry_after_seconds from incremented
    `;
    const row = rows[0];
    if (!row) throw new Error('rate-limit increment returned no row');
    return { allowed: row.count <= input.limit, count: row.count, retryAfterSeconds: row.retry_after_seconds };
  }
}
