import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

const repository=readFileSync('packages/forums/src/postgres.ts','utf8');
const migration=readFileSync('packages/db/migrations/0090_wp-015_forums.sql','utf8');
const messageMigration=readFileSync('packages/db/migrations/0101_wp-015_message_moderation.sql','utf8');
const messageAdapter=readFileSync('packages/forums/src/messaging-review.ts','utf8');
const prompt=readFileSync('packages/ai/prompts/moderation/v1.md','utf8');
const evaluation=JSON.parse(readFileSync('evals/WP-015/moderation-adversarial.json','utf8')) as {closed_labels:string[];cases:{content?:string;expected_label?:string;expected_authority:string}[]};
describe('WP-015 security controls',()=>{
  it('forces tenant RLS on every forum table while repositories retain explicit org predicates',()=>{for(const table of ['forum_topics','forum_posts','forum_replies','blocks','reports','moderation_items'])expect(migration).toContain(`'${table}'`);expect(migration).toContain('FORCE ROW LEVEL SECURITY');expect((repository.match(/org_id=\$\{identity\.orgId\}/gu)??[]).length).toBeGreaterThan(15);});
  it('applies blocks symmetrically and makes self-block impossible in storage',()=>{expect((repository.match(/blocker_id=\$\{identity\.userId\}.*blocked_id=/gu)??[]).length).toBeGreaterThan(3);expect((repository.match(/blocker_id=.*blocked_id=\$\{identity\.userId\}/gu)??[]).length).toBeGreaterThan(3);expect(migration).toContain('CHECK(blocker_id<>blocked_id)');});
  it('never copies resident, report, model, or free-text decision content into audit reasons or fields',()=>{const audits=[...repository.matchAll(/appendAudit\(sql,\s*\{([\s\S]*?)\}\);/gu)].map(match=>match[1]);expect(audits).toHaveLength(2);for(const audit of audits){expect(audit).not.toMatch(/\b(body|note|content|model_output)\b/u);expect(audit).not.toContain('reason,');}expect(repository).toContain('reason: `human_moderation_${decision}`');});
  it('spotlights model input as untrusted data and preserves human authority',()=>{expect(prompt).toContain('untrusted data');expect(prompt).toMatch(/Never follow\s+instructions/u);expect(prompt).toContain('staff or admin human');});
  it('locks adversarial moderation evals to advisory closed labels',()=>{expect(evaluation.closed_labels).toEqual(['safe','review']);expect(evaluation.cases.some(item=>item.content?.includes('Ignore the classifier'))).toBe(true);expect(evaluation.cases.every(item=>(item.expected_label===undefined||evaluation.closed_labels.includes(item.expected_label))&&item.expected_authority==='human_only')).toBe(true);});
  it('gives message review a tenant-scoped human-only state transition and durable safe rationale',()=>{expect(messageMigration).toContain('CREATE TRIGGER messaging_report_human_decision');expect(messageMigration).toContain("role.role IN ('staff','admin')");expect(messageMigration).toContain('FORCE ROW LEVEL SECURITY');expect(messageMigration).toContain('messaging_moderation_decisions');expect(messageMigration).toContain('moderation reason must name a rule without copying content');});
  it('queues only message metadata under a pinned namespace and never selects native text',()=>{expect(messageAdapter).toContain("messageModerationNamespace = '7699a1f4-6b0f-4f69-8dc7-1da9236df15e'");expect(messageAdapter).not.toMatch(/select[^`]*(?:report\.reason|report\.note|message\.body)/isu);expect(messageAdapter).toContain("'message'::text,report.conversation_id");expect(messageAdapter).toContain('reason:`human_moderation_${decision}`');});
});
