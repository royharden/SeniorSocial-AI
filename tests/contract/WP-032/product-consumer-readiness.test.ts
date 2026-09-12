import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import findings from './product-consumer-findings.json';
import blockers from './consumer-adoption-blockers.json';
import policy from '../../../packages/i18n/es/catalog-policy.json';

const root = resolve(import.meta.dirname, '../../..');
type AdoptionBlocker = {
  readonly namespace: string;
  readonly owner: string;
  readonly role: string;
  readonly route: string;
  readonly expected_usage: string;
  readonly current_wiring: string;
  readonly critical_keys: readonly string[];
  readonly receipts: ReadonlyArray<{ readonly file: string; readonly line: number; readonly literal: string }>;
};
const adoptionBlockers = blockers.findings as readonly AdoptionBlocker[];

describe('WP-032 product consumer readiness', () => {
  it('pins selected known out-of-scope literal findings to exact source lines', async () => {
    // what_bug_this_catches: a known product literal drifting while the catalog migration remains blocked.
    const namespaces = new Set<string>();
    for (const finding of findings) {
      const source = await readFile(resolve(root, finding.file), 'utf8');
      const line = source.split(/\r?\n/u)[finding.line - 1] ?? '';
      expect(line, `${finding.key} moved from ${finding.file}:${finding.line}`).toContain(finding.literal);
      namespaces.add(finding.key.split('.')[0] ?? '');
    }
    expect([...namespaces].sort()).toEqual([]);
  });

  it('reports completed catalog consumer adoption without claiming translation approval', () => {
    // what_bug_this_catches: leaving consumer adoption blocked after every catalog-backed product finding is closed.
    expect(policy.consumer_readiness.status).toBe('catalogs_complete_consumers_adopted');
    expect(findings).toEqual([]);
  });

  it('pins approval-aware consumer blockers with owner, role, route, and critical-key evidence', async () => {
    // what_bug_this_catches: reporting public critical Spanish fallback as integrated while a product still selects local or raw Spanish copy.
    expect(blockers.schema_version).toBe(1);
    expect(blockers.expected_resolver_import).toBe('@seniorsocial/i18n/catalogs');
    expect(adoptionBlockers.map(finding => finding.namespace).sort()).toEqual([]);
    for (const finding of adoptionBlockers) {
      expect(finding.owner).toMatch(/^WP-\d{3} /u);
      expect(finding.role.length).toBeGreaterThan(0);
      expect(finding.route).toMatch(/^\//u);
      expect(finding.expected_usage).toBe('resolveCatalogMessage');
      expect(finding.current_wiring).toMatch(/bypass/u);
      expect(finding.receipts.length).toBeGreaterThan(0);
      for (const receipt of finding.receipts) {
        const source = await readFile(resolve(root, receipt.file), 'utf8');
        const line = source.split(/\r?\n/u)[receipt.line - 1] ?? '';
        expect(line, `${finding.owner} blocker moved from ${receipt.file}:${receipt.line}`).toContain(receipt.literal);
        expect(source, `${finding.owner} now uses the resolver; remove this stale blocker`).not.toContain('resolveCatalogMessage');
      }
    }
  });

  it('records every mechanically critical namespace that remains blocked', () => {
    // what_bug_this_catches: a blocker inventory omitting a critical family after a different consumer completes migration.
    const byNamespace = Object.fromEntries(adoptionBlockers.map(finding => [finding.namespace, finding]));
    expect(byNamespace.assistance).toBeUndefined();
    expect(byNamespace.caregiver).toBeUndefined();
    expect(byNamespace.intake).toBeUndefined();
    expect(byNamespace.messages).toBeUndefined();
    expect(byNamespace.translate).toBeUndefined();
  });

  it('closes only the translate consumer blocker through the public approval-aware entry', async () => {
    // what_bug_this_catches: removing the translate blocker without actually eliminating raw locale selection in the workbench.
    const source = await readFile(resolve(root, 'apps/web/app/translate/workbench.tsx'), 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain('resolveCatalogMessage');
    expect(source).not.toMatch(/packages\/i18n\/(?:en|es)\/translate\.json/u);
    expect(source).not.toMatch(/locale\s*===\s*['"]es['"]\s*\?/u);
    expect(adoptionBlockers.some(finding => finding.namespace === 'translate')).toBe(false);
  });

  it('closes the events literal findings through the public approval-aware entry', async () => {
    // what_bug_this_catches: deleting event findings while the page still bypasses review status or embeds stale UI copy.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/events/page.tsx'), 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain('resolveCatalogMessage');
    expect(source).toContain("namespace: 'events'");
    expect(source).not.toMatch(/packages\/i18n\/(?:en|es)\/events\.json/u);
    expect(source).not.toContain("locale === 'es' ? 'Eventos'");
    expect(findings.some(finding => finding.key.startsWith('events.'))).toBe(false);
  });
});
