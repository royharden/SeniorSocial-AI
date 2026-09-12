import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { resetDemoFixture } from '../../../packages/db/seed/demo/reset.ts';
import { AesGcmNarrativeCodec } from '../../../packages/assistance/src/crypto.ts';

const encryptionKey = Buffer.alloc(32, 34).toString('base64');
const codec = new AesGcmNarrativeCodec(encryptionKey);

const migration = new URL('../../../packages/db/migrations/0180_wp-034_demo.sql', import.meta.url);
const journeySeed = new URL('../../../packages/db/seed/demo/journey.ts', import.meta.url);

describe('WP-034 reset security boundary', () => {
  it('rejects a cross-org target before opening a database transaction', async () => {
    // what_bug_this_catches: an operator-controlled org id turning demo reset into tenant deletion.
    let began = false;
    const client = { begin: () => { began = true; return Promise.resolve(); } };
    await expect(resetDemoFixture(client as never, { orgId: '22222222-2222-4222-8222-222222222222', userId: '34000000-0000-4000-8000-000000000006' }, 'synthetic-pepper-only', codec)).rejects.toThrow('designated synthetic tenant');
    expect(began).toBe(false);
  });

  it('keeps the encryption key and plaintext assistance narrative out of SQL', async () => {
    // what_bug_this_catches: repairing the fixture by passing the runtime key or unencrypted narrative into the privileged SQL function.
    const sql = await readFile(migration, 'utf8');
    expect(sql).not.toContain('synthetic-demo-ciphertext');
    expect(sql).not.toContain('ASSISTANCE_ENCRYPTION_KEY');
    expect(sql).not.toContain('Avery needs transportation help');
    expect(sql).not.toMatch(/seniorsocial_reset_demo\([^)]*cipher/iu);
  });

  it('requires same-org actor context, an active demo admin, and emits a value-free audit record', async () => {
    // what_bug_this_catches: a resident/non-admin reset, forged actor id, or secrets/fixture values entering audit.
    const sql = await readFile(migration, 'utf8');
    expect(sql).toContain("current_setting('app.current_user_id'");
    expect(sql).toMatch(/r\.role='admin'/u);
    expect(sql).toContain("u.account_state='active'");
    expect(sql).toContain('REVOKE ALL ON FUNCTION seniorsocial_reset_demo(uuid,uuid,text,text) FROM seniorsocial_app');
    expect(sql).not.toContain('GRANT EXECUTE ON FUNCTION seniorsocial_reset_demo');
    expect(sql).toContain("'system:demo_reset','demo.reset','demo_fixture:wp-034.v1'");
    expect(sql).toContain("'versioned synthetic fixture restored',ARRAY[]::text[]");
    expect(sql).not.toMatch(/audit_events[\s\S]{0,250}requested_pepper/u);
  });

  it('contains no reachable seeded contact and explicitly disables every outbound channel', async () => {
    // what_bug_this_catches: a demo click reaching an actual email, SMS, or voice destination.
    const sql = await readFile(migration, 'utf8');
    const emails = sql.match(/[A-Za-z0-9.]+@[A-Za-z0-9.-]+/gu) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every(email => email.endsWith('@example.invalid'))).toBe(true);
    expect(sql).not.toMatch(/\+\d{7,}/u);
    expect(sql).toContain('"outbound":"disabled","email":false,"sms":false,"voice":false');
    expect(sql).toContain("'notification_outbox',(SELECT count(*)");
  });

  it('never turns reviewer setup into caregiver authority or a reachable contact', async () => {
    // what_bug_this_catches: a convenient reviewer fixture bypassing resident read-back or embedding a deliverable address.
    const source = await readFile(journeySeed, 'utf8');
    expect(source).toContain("'pending',0");
    expect(source).toContain('resident must confirm every scope');
    expect(source).not.toMatch(/insert into consent_(?:grants|scopes|read_backs)/u);
    expect(source).not.toMatch(/@[A-Za-z0-9.-]+|\+\d{7,}/u);
  });

  it('disables AI only through the synthetic tenant override and seeds no provider result', async () => {
    // what_bug_this_catches: demo preparation changing the global kill switch or fabricating evidence of an AI call.
    const source = await readFile(journeySeed, 'utf8');
    expect(source).toContain("scope='org' and flag_key in ('ai.master','ai.concierge')");
    expect(source).toContain('set enabled=false');
    expect(source).not.toMatch(/update feature_flags[\s\S]*scope='global'/u);
    expect(source).not.toMatch(/insert into ai_events|provider|model|prompt_version/u);
  });
});
