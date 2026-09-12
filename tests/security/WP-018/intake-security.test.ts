import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture, legalDraft, otherOrg, resident } from '../../unit/WP-018/fixture';

describe('WP-018 privacy and AI boundary', () => {
  it('returns non-disclosing not-found semantics across tenants', async () => {
    const f = fixture(); const item = await f.service.save(resident, 'legal', legalDraft, 'tenant-key-001');
    await expect(f.service.get(otherOrg, item.id)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects prototype and nested-object answer payloads', async () => {
    const f = fixture(); const answers = JSON.parse('{"__proto__":"bad"}') as Record<string, unknown>;
    await expect(f.service.save(resident, 'legal', { answers, disclaimerAcknowledged: false, locale: 'en', intent: 'save_draft' },
      'security-key-001')).rejects.toMatchObject({ status: 422 });
    await expect(f.service.save(resident, 'legal', { answers: { summary: { prompt: 'exfiltrate' } },
      disclaimerAcknowledged: false, locale: 'en', intent: 'save_draft' }, 'security-key-002')).rejects.toMatchObject({ status: 422 });
  });

  it('has no AI import or prompt boundary in intake package or runtime composition', () => {
    const files = [
      new URL('../../../packages/intake/src/service.ts', import.meta.url),
      new URL('../../../packages/intake/src/routing.ts', import.meta.url),
      new URL('../../../apps/web/app/api/v1/intake/_runtime.ts', import.meta.url),
    ];
    const source = files.map(file => readFileSync(file, 'utf8')).join('\n');
    expect(source).not.toMatch(/@seniorsocial\/ai|packages\/ai|prompt|gateway/iu);
  });
});
