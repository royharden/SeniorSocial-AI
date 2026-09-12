import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestSecret, assertConstrainedRuntimeRole, type AuthSql } from '../../../packages/auth/src/index.ts';
import { PostgresCaregiverRepository, type CaregiverPostgresFactory } from '../../../packages/caregiver/src/index.ts';
import { POST as inviteCaregiver } from '../../../apps/web/app/api/v1/caregiver/invitations/route.ts';
import { POST as acceptCaregiver } from '../../../apps/web/app/api/v1/caregiver/invitations/[token]/accept/route.ts';
import { PUT as setScopes } from '../../../apps/web/app/api/v1/caregiver/links/[linkId]/scopes/route.ts';
import { DELETE as revokeLink } from '../../../apps/web/app/api/v1/caregiver/links/[linkId]/route.ts';
import { GET as listCaregiverLinks } from '../../../apps/web/app/api/v1/caregiver/links/route.ts';
import { GET as listMyCaregivers } from '../../../apps/web/app/api/v1/me/caregivers/route.ts';
import {
  closeCaregiverRuntimeForTests, runtimeDependencies, setCaregiverMailpitTransportForTests,
} from '../../../apps/web/app/api/v1/caregiver/_runtime.ts';

const require = createRequire(new URL('../../../packages/caregiver/package.json', import.meta.url));
const postgres = require('postgres') as CaregiverPostgresFactory;
const clusterUrl = process.env.AUTH_TEST_CLUSTER_URL;
if (!clusterUrl) throw new Error('AUTH_TEST_CLUSTER_URL is required; live WP-017 integration tests never skip');
const requiredClusterUrl: string = clusterUrl;
const databaseName = `seniorsocial_wp017_test_${process.pid}_${Date.now()}`;
const runtimeRole = `wp017_runtime_${process.pid}_${Date.now()}`;
const runtimePassword = `Wp017-${process.pid}-runtime`;
const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const residentId = '11111111-1111-4111-8111-111111111101';
const caregiverId = '11111111-1111-4111-8111-111111111102';
const otherId = '22222222-2222-4222-8222-222222222201';
const residentToken = 'resident-session-token';
const caregiverToken = 'caregiver-session-token';
const pepper = 'synthetic-auth-pepper-at-least-16';
let admin: ReturnType<typeof postgres>;
let owner: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;
let runtimeUrl = '';
let isolatedUrl = '';
const captures: { url: string; message: Record<string, unknown> }[] = [];

const mailpitTransport: typeof fetch = async (input, init) => {
  const url = input instanceof URL ? input.toString() : input instanceof Request ? input.url : input;
  const message = JSON.parse(String(init?.body)) as Record<string, unknown>;
  captures.push({ url, message });
  return new Response(JSON.stringify({ ID: `wp017-${captures.length}` }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
};

function databaseUrl(name: string): string {
  const url = new URL(requiredClusterUrl); url.pathname = `/${name}`; return url.toString();
}

function migrate(direction: 'up' | 'down', url: string): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: join(process.cwd(), 'packages', 'db'),
    env: { ...process.env, DATABASE_URL: url, DATABASE_SSL: 'disable' }, stdio: 'pipe',
  });
}
const request = (path: string, token: string, method = 'GET', body?: unknown) => new Request(`http://local/api/v1${path}`, {
  method, headers: { cookie: `ss_session=${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('WP-017 disposable PostgreSQL and live route composition', () => {
  beforeAll(async () => {
    admin = postgres(requiredClusterUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    isolatedUrl = databaseUrl(databaseName);
    migrate('up', isolatedUrl); migrate('down', isolatedUrl); migrate('up', isolatedUrl);
    owner = postgres(isolatedUrl, { max: 1 });
    await owner.unsafe(`
      insert into orgs (id,name,slug) values
        ('${orgA}','Synthetic North','synthetic-north'), ('${orgB}','Synthetic South','synthetic-south');
      insert into users (id,org_id,display_name,email,phone) values
        ('${residentId}','${orgA}','Synthetic Resident','resident@example.invalid',null),
        ('${caregiverId}','${orgA}','Synthetic Caregiver','helper@example.invalid','+15550170102'),
        ('${otherId}','${orgB}','Synthetic Other','other@example.invalid',null);
      insert into user_roles (org_id,user_id,role) values
        ('${orgA}','${residentId}','senior'), ('${orgA}','${caregiverId}','caregiver'), ('${orgB}','${otherId}','senior');
      insert into sessions (org_id,user_id,token_digest,expires_at) values
        ('${orgA}','${residentId}','${digestSecret(residentToken, pepper)}',now()+interval '1 hour'),
        ('${orgA}','${caregiverId}','${digestSecret(caregiverToken, pepper)}',now()+interval '1 hour');
      create role "${runtimeRole}" login password '${runtimePassword}' in role seniorsocial_app;
    `);
    const url = new URL(isolatedUrl); url.username = runtimeRole; url.password = runtimePassword; runtimeUrl = url.toString();
    runtime = postgres(runtimeUrl, { max: 4 });
    process.env.DATABASE_URL = runtimeUrl; process.env.DATABASE_SSL = 'disable'; process.env.SENIORSOCIAL_ORG_ID = orgA;
    process.env.AUTH_TOKEN_PEPPER = pepper; process.env.CAREGIVER_RECIPIENT_HMAC_KEY = 'synthetic-recipient-hmac-key-at-least-32';
    process.env.MAILPIT_URL = 'http://127.0.0.1:8025/';
    setCaregiverMailpitTransportForTests(mailpitTransport);
  }, 60_000);

  afterAll(async () => {
    await closeCaregiverRuntimeForTests();
    if (runtime) await runtime.end();
    if (owner) await owner.end();
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.unsafe(`drop role if exists "${runtimeRole}"`);
      await admin.end();
    }
    delete process.env.DATABASE_URL; delete process.env.DATABASE_SSL; delete process.env.SENIORSOCIAL_ORG_ID;
    delete process.env.AUTH_TOKEN_PEPPER; delete process.env.CAREGIVER_RECIPIENT_HMAC_KEY; delete process.env.MAILPIT_URL;
  });

  it('runs the actual route exports and accepts one concurrent recipient-bound activation', async () => {
    // what_bug_this_catches: factories pass while exported routes stay 503, trust a caller recipient, or accept a token twice.
    const invited = await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', {
      email_or_phone: 'HELPER@example.invalid', relationship_note: 'Synthetic trusted helper',
    }));
    expect(invited.status).toBe(201); expect(captures).toHaveLength(1);
    expect(captures[0]?.url).toBe('http://127.0.0.1:8025/api/v1/send');
    expect(captures[0]?.message.To).toEqual([{ Email: expect.stringMatching(/^capture-[a-f0-9]{16}@example\.invalid$/u) }]);
    const text = String(captures[0]?.message.Text);
    const rawToken = /Caregiver invitation token: ([A-Za-z0-9_-]+)/u.exec(text)?.[1] ?? '';
    expect(rawToken).not.toBe('');
    const attempts = await Promise.all([1, 2].map(() => acceptCaregiver(request('/caregiver/invitations/token/accept', caregiverToken, 'POST'),
      { params: Promise.resolve({ token: rawToken }) })));
    expect(attempts.map(response => response.status).sort()).toEqual([200, 404]);
    const links = await owner<{ id: string }[]>`select id from caregiver_links where org_id=${orgA} and caregiver_id=${caregiverId}`;
    expect(links).toHaveLength(1);
    expect(await owner<{ count: number }[]>`select count(*)::int as count from audit_events where action='caregiver.accepted'`)
      .toEqual([{ count: 1 }]);
  });

  it('lists both frozen perspectives, enforces RLS, and revokes on the next request', async () => {
    // what_bug_this_catches: /me/caregivers is omitted, RLS confirms cross-org rows, or a cached grant survives revocation.
    const link = (await owner<{ id: string }[]>`select id from caregiver_links where org_id=${orgA} and caregiver_id=${caregiverId}`)[0];
    expect(link).toBeDefined();
    // Exercise the cached configured service -> non-invitation service transition without resetting test seams.
    delete process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
    delete process.env.MAILPIT_URL;
    expect((await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', {
      email_or_phone: 'helper@example.invalid',
    }))).status).toBe(503);
    expect((await acceptCaregiver(request('/caregiver/invitations/token/accept', caregiverToken, 'POST'),
      { params: Promise.resolve({
        token: 'synthetic-token-with-at-least-32-characters', // secrets-scan: allow — deterministic local fixture
      }) })).status).toBe(503);
    for (const token of ['', caregiverToken]) {
      expect((await setScopes(request(`/caregiver/links/${link?.id}/scopes`, token, 'PUT', {
        scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: true,
      }), { params: Promise.resolve({ linkId: link?.id ?? '' }) })).status).toBe(404);
    }
    expect((await setScopes(request(`/caregiver/links/${link?.id}/scopes`, residentToken, 'PUT', {
      scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: false,
    }), { params: Promise.resolve({ linkId: link?.id ?? '' }) })).status).toBe(404);
    const granted = await setScopes(request(`/caregiver/links/${link?.id}/scopes`, residentToken, 'PUT', {
      scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: true,
    }), { params: Promise.resolve({ linkId: link?.id ?? '' }) });
    expect(granted.status).toBe(200);
    expect((await listMyCaregivers(request('/me/caregivers', residentToken))).status).toBe(200);
    expect((await listCaregiverLinks(request('/caregiver/links', caregiverToken))).status).toBe(200);
    const identity = { orgId: orgA, userId: caregiverId, roles: ['caregiver'] as const };
    expect(await runtimeDependencies.service.authorize(identity, { linkId: link?.id ?? '', residentId, resource: 'schedule', action: 'read' })).toBe(true);
    const crossOrg = new PostgresCaregiverRepository(runtime, sql => assertConstrainedRuntimeRole(sql as unknown as AuthSql));
    expect(await crossOrg.transaction(orgB, transaction => transaction.linkById(link?.id ?? ''))).toBeNull();
    expect((await revokeLink(request(`/caregiver/links/${link?.id}`, residentToken, 'DELETE'),
      { params: Promise.resolve({ linkId: link?.id ?? '' }) })).status).toBe(204);
    expect(await runtimeDependencies.service.authorize(identity, { linkId: link?.id ?? '', residentId, resource: 'schedule', action: 'read' })).toBe(false);
    process.env.CAREGIVER_RECIPIENT_HMAC_KEY = 'synthetic-recipient-hmac-key-at-least-32';
    process.env.MAILPIT_URL = 'http://127.0.0.1:8025/';
  });

  it('fails before persistence on capture failure and rolls back atomically after a confirmed ghost capture', async () => {
    // what_bug_this_catches: an unusable invitation commits after capture failure, or domain state survives a later audit failure.
    const before = (await owner<{ count: number }[]>`select count(*)::int as count from caregiver_invitations`)[0]?.count;
    await closeCaregiverRuntimeForTests();
    setCaregiverMailpitTransportForTests(async () => new Response('{}', { status: 503 }));
    const uncaptured = await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', { email_or_phone: '+15550170103' }));
    expect(uncaptured.status).toBe(503);
    expect((await owner<{ count: number }[]>`select count(*)::int as count from caregiver_invitations`)[0]?.count).toBe(before);
    setCaregiverMailpitTransportForTests(mailpitTransport);
    const capturesBeforeAuditFailure = captures.length;
    await owner.unsafe(`create function fail_wp017_invite_audit() returns trigger language plpgsql as $$ begin
      if new.action='caregiver.invited' then raise exception 'forced wp017 audit failure'; end if; return new; end $$;
      create trigger fail_wp017_invite_audit before insert on audit_events for each row execute function fail_wp017_invite_audit();`);
    const failed = await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', { email_or_phone: '+15550170103' }));
    expect(failed.status).toBe(503);
    expect((await owner<{ count: number }[]>`select count(*)::int as count from caregiver_invitations`)[0]?.count).toBe(before);
    // Mailpit may contain this harmless ghost capture, but no usable token digest or invitation state committed.
    expect(captures).toHaveLength(capturesBeforeAuditFailure + 1);
    await owner.unsafe('drop trigger fail_wp017_invite_audit on audit_events; drop function fail_wp017_invite_audit()');
    await closeCaregiverRuntimeForTests(); delete process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
    expect((await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', { email_or_phone: '+15550170103' }))).status).toBe(503);
    process.env.CAREGIVER_RECIPIENT_HMAC_KEY = 'synthetic-recipient-hmac-key-at-least-32';
    delete process.env.MAILPIT_URL;
    expect((await inviteCaregiver(request('/caregiver/invitations', residentToken, 'POST', { email_or_phone: '+15550170103' }))).status).toBe(503);
    expect((await owner<{ count: number }[]>`select count(*)::int as count from caregiver_invitations`)[0]?.count).toBe(before);
    process.env.MAILPIT_URL = 'http://127.0.0.1:8025/';
  });
});
