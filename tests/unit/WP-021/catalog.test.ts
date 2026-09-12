import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import en from '../../../packages/i18n/en/translate.json';
import es from '../../../packages/i18n/es/translate.json';
import status from '../../../packages/i18n/es/translate.status.json';
import policy from '../../../packages/i18n/es/catalog-policy.json';

describe('WP-021 translate catalog', () => {
  it('is complete, Spanish, provisional, and mechanically source-bound', async () => {
    // what_bug_this_catches: untranslated or falsely approved workflow UI surviving an English source edit.
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(es[key]).not.toBe(en[key]);
    expect(Object.keys(status).sort()).toEqual(Object.keys(es).map(key => `translate.${key}`).sort());
    const digest = createHash('sha256').update(await readFile(new URL('../../../packages/i18n/en/translate.json', import.meta.url))).digest('hex');
    expect(policy.current_source_namespaces.translate).toEqual({ source_version: `sha256:${digest}`, source_sha256: digest });
    for (const entry of Object.values(status)) expect(entry).toEqual({ status: 'draft', source_version: `sha256:${digest}`, critical: false, machine_generated: true });
  });
});
