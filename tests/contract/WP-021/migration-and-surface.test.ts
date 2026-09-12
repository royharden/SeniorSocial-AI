import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

describe('WP-021 storage and route contract', () => {
  it('owns reversible 0150 tables, normative states, RLS, and atomic source invalidation', async () => {
    // what_bug_this_catches: schema drift allowing stale approved copy to survive an English edit.
    const up = await migration('0150_wp-021_translations.sql'); const down = await migration('0150_wp-021_translations.down.sql');
    expect(up).toContain("('draft', 'awaiting_review', 'approved', 'invalidated')");
    expect(up).toContain("invalidation_reason='source_changed'");
    expect(up).toMatch(/ALTER TABLE translation_(sources|drafts).*FORCE ROW LEVEL SECURITY/g);
    expect(up).toContain('translation_qualified_reviewers');
    expect(up).toContain('wp021_approve_translation');
    expect(up).toContain('wp021_publish_translation');
    expect(up).toContain("canonical_hash char(64) := encode(digest(convert_to(requested_text,'UTF8'),'sha256'),'hex')");
    expect(up).not.toContain('requested_hash');
    expect(up).toContain('FOREIGN KEY (org_id, ai_event_id) REFERENCES ai_events(org_id, id)');
    expect(up).toContain("feature='translation_assist' AND outcome='ok'");
    expect(up).toContain("'translation.approved'");
    expect(up).toContain("'translation.invalidated'");
    for (const table of ['translation_events', 'translation_drafts', 'translation_qualified_reviewers', 'translation_sources']) expect(down).toContain(`DROP TABLE IF EXISTS ${table}`);
  });

  it('keeps stable source hashes, machine provenance, reviewer evidence, and publication history', async () => {
    // what_bug_this_catches: publication records that cannot prove which source or reviewer they belong to.
    const up = await migration('0150_wp-021_translations.sql');
    for (const field of ['source_hash', 'source_version', 'machine_generated', 'ai_event_id', 'reviewed_by', 'reviewer_qualification', 'reviewer_note', 'reviewed_at', 'published_by', 'published_at']) expect(up).toContain(field);
    expect(up).toContain("machine_generated = (provenance = 'machine')");
    expect(up).toContain("status='approved'");
    expect(up).toContain("'invalidated',requested_actor,row.source_version,row.source_version+1");
    expect(up).toContain('FOR UPDATE');
    expect(up).toContain("event_type,actor_id,to_source_version");
  });

  it('implements the canonical approval route without accepting actor, org, reviewer, or source hash', async () => {
    // what_bug_this_catches: shipping only an undocumented generic action endpoint or trusting reviewer identity from JSON.
    const route = await readFile(new URL('../../../apps/web/app/api/v1/admin/translations/[entryId]/approve/route.ts', import.meta.url), 'utf8');
    expect(route).toContain("exactBody(body, ['source_version', 'reviewer_note'])");
    expect(route).toContain('workflow.approveCanonical');
    expect(route).not.toMatch(/body\.(?:actor|org|sourceHash|reviewer(?!_note))/u);
  });
});
