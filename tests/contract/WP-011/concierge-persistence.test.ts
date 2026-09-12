import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const up = readFileSync(new URL('../../../packages/db/migrations/0190_wp-011_concierge_conversations.sql', import.meta.url), 'utf8');
const down = readFileSync(new URL('../../../packages/db/migrations/0190_wp-011_concierge_conversations.down.sql', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../../../apps/web/app/api/v1/concierge/_runtime.ts', import.meta.url), 'utf8');
const store = readFileSync(new URL('../../../apps/web/app/concierge/postgres.ts', import.meta.url), 'utf8');

describe('WP-011 durable concierge contract', () => {
  it('composes PostgreSQL in production without changing the isolated test store', () => {
    expect(runtime).toContain('new PostgresConversationStore(conversationDatabase)');
    expect(runtime).toContain("process.env.NODE_ENV === 'test' ? processLocalConversationStore() : undefined");
    expect(runtime).not.toContain('intentionally not durable');
  });

  it('binds persisted conversations to both tenant and resident under forced RLS', () => {
    expect(up).toContain('CREATE TABLE concierge_conversations');
    expect(up).toContain('PRIMARY KEY (org_id, id)');
    expect(up).toContain('FOREIGN KEY (org_id, user_id) REFERENCES users(org_id, id)');
    expect(up).toContain('ALTER TABLE concierge_conversations FORCE ROW LEVEL SECURITY');
    expect(up).toContain("org_id = nullif(current_setting('app.current_org_id', true), '')::uuid");
    expect(up).toContain("user_id = nullif(current_setting('app.current_user_id', true), '')::uuid");
  });

  it('grants only the mutations needed for append and handoff persistence and has a complete rollback', () => {
    expect(up).toContain('GRANT UPDATE (turns, ai_enabled, last_question, handoff, revision, updated_at)');
    expect(up).toContain('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER');
    expect(up).toContain('CREATE TRIGGER concierge_conversation_update_guard BEFORE UPDATE');
    expect(up).toContain('OLD.handoff IS NOT NULL AND NEW.handoff IS DISTINCT FROM OLD.handoff');
    expect(up).toContain('jsonb_array_length(NEW.turns) < jsonb_array_length(OLD.turns)');
    // Containment ignores order, duplicate counts and additional fields in old objects.
    expect(up).not.toContain('NEW.turns @> OLD.turns');
    expect(up).toContain('jsonb_array_elements(OLD.turns) WITH ORDINALITY');
    expect(up).toContain('NEW.turns -> (previous.position::integer - 1) IS DISTINCT FROM previous.turn');
    expect(down).toContain('DROP TABLE IF EXISTS concierge_conversations;');
    expect(down).toContain('DROP FUNCTION IF EXISTS guard_concierge_conversation_update();');
  });

  it('merges answer deltas atomically and serializes handoff creation on the durable row', () => {
    expect(store).toContain('set turns = turns ||');
    expect(store).toContain("ai_enabled = ai_enabled and");
    expect(store).toContain('for update');
    expect(store).toMatch(/find\(sql, id, orgId, userId, true\)[\s\S]+const result = await create/u);
    expect(store).toContain('and handoff is null');
  });
});
