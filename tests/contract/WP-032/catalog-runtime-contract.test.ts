import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import policy from '../../../packages/i18n/es/catalog-policy.json';
import {
  catalogs,
  resolveCatalogMessage,
  type CatalogKey,
  type CatalogNamespace,
} from '../../../packages/i18n/src/catalogs';
import {
  catalogSourceSha256,
  serializeCatalog,
  sha256Utf8,
} from '../../../packages/i18n/src/catalog-resolver';
import type { CatalogResolution } from '../../../packages/i18n/src/catalog-resolver';

const root = resolve(import.meta.dirname, '../../..');
const englishRoot = resolve(root, 'packages/i18n/en');

type EsbuildResult = {
  readonly outputFiles: ReadonlyArray<{ readonly text: string }>;
  readonly metafile?: { readonly inputs: Readonly<Record<string, unknown>> };
};

async function loadInstalledEsbuild(): Promise<(options: Record<string, unknown>) => Promise<EsbuildResult>> {
  const virtualStore = resolve(root, 'node_modules/.pnpm');
  const versions = (await readdir(virtualStore)).filter(name => name.startsWith('esbuild@')).sort().reverse();
  const selected = versions[0];
  if (selected === undefined) throw new Error('Installed esbuild package not found');
  const entry = resolve(virtualStore, selected, 'node_modules/esbuild/lib/main.js');
  const loaded = await import(pathToFileURL(entry).href) as { build?: (options: Record<string, unknown>) => Promise<EsbuildResult> };
  if (typeof loaded.build !== 'function') throw new Error('Installed esbuild build API not found');
  return loaded.build;
}

function resolveFirst(namespace: CatalogNamespace) {
  const key = Object.keys(catalogs.en[namespace])[0] as CatalogKey<typeof namespace>;
  return resolveCatalogMessage({ locale: 'es', namespace, key });
}

describe('WP-032 catalog runtime contract', () => {
  it('matches imported catalogs to exact deterministic raw bytes and policy SHA bindings', async () => {
    // what_bug_this_catches: JSON import normalization making runtime approval checks hash different bytes from review metadata.
    for (const namespace of Object.keys(catalogs.en) as CatalogNamespace[]) {
      const raw = await readFile(resolve(englishRoot, `${namespace}.json`), 'utf8');
      const deterministic = serializeCatalog(catalogs.en[namespace]);
      expect(raw, namespace).toBe(deterministic);
      const nodeDigest = createHash('sha256').update(raw).digest('hex');
      expect(catalogSourceSha256(catalogs.en[namespace]), namespace).toBe(nodeDigest);
      expect(policy.current_source_namespaces[namespace]).toEqual({
        source_sha256: nodeDigest,
        source_version: `sha256:${nodeDigest}`,
      });
    }
  });

  it('exposes every built-in namespace, including auth, through the approval-aware resolver', () => {
    // what_bug_this_catches: a newly cataloged namespace being omitted from the shared runtime topology.
    expect(Object.keys(catalogs.en).sort()).toEqual([
      'admin', 'assistance', 'auth', 'caregiver', 'common', 'events', 'groups', 'intake',
      'messages', 'notify', 'profile', 'reports', 'rides', 'services', 'shell', 'translate',
    ]);
    expect(Object.keys(catalogs.es).sort()).toEqual(Object.keys(catalogs.en).sort());
    for (const namespace of Object.keys(catalogs.en) as CatalogNamespace[]) {
      const result = resolveFirst(namespace);
      expect(result.found, namespace).toBe(true);
      expect(result.renderedLocale, namespace).toBe('en');
      expect(result.fallbackReason, namespace).not.toBe('source_drift');
      expect(result.fallbackReason, namespace).not.toBe('missing_metadata');
      expect(result.fallbackReason, namespace).not.toBe('malformed_metadata');
    }
    expect(resolveCatalogMessage({ locale: 'es', namespace: 'assistance', key: 'emergency.heading' })).toMatchObject({
      critical: true, renderState: 'held_english_fallback', fallbackReason: 'critical_not_approved',
      affordance: policy.critical_fallback.affordance,
    });
    expect(resolveCatalogMessage({ locale: 'es', namespace: 'notify', key: 'body.minimal' })).toMatchObject({
      critical: false, renderState: 'provisional_english_fallback', fallbackReason: 'provisional_translation',
    });
  });

  it('keeps namespace and key relationships typed', () => {
    // what_bug_this_catches: consumer code accepting an arbitrary key that belongs to another namespace.
    expectTypeOf<'body.minimal'>().toMatchTypeOf<CatalogKey<'notify'>>();
    expectTypeOf<'invalid_request'>().toMatchTypeOf<CatalogKey<'auth'>>();
    expectTypeOf<'status.confirmed_by'>().toMatchTypeOf<CatalogKey<'rides'>>();
  });

  it('narrows resolution guarantees by renderState', () => {
    // what_bug_this_catches: consumers needing unsafe assertions after checking the resolver discriminant.
    const assertNarrowing = (result: CatalogResolution) => {
      if (result.renderState === 'approved_spanish') {
        expectTypeOf(result.renderedLocale).toEqualTypeOf<'es'>();
        expectTypeOf(result.reviewStatus).toEqualTypeOf<'approved'>();
        expectTypeOf(result.fallbackReason).toEqualTypeOf<null>();
        expectTypeOf(result.affordance).toEqualTypeOf<null>();
      } else if (result.renderState === 'unknown_message') {
        expectTypeOf(result.found).toEqualTypeOf<false>();
        expectTypeOf(result.renderedLocale).toEqualTypeOf<null>();
      }
    };
    assertNarrowing(resolveCatalogMessage({ locale: 'en', namespace: 'common', key: 'confirm' }));
  });

  it('matches independent SHA-256 vectors across UTF-8 and block boundaries', () => {
    // what_bug_this_catches: padding logic passing short ASCII tests but failing at SHA block boundaries or Unicode input.
    const vectors = ['', 'Sí, señor', 'a'.repeat(55), 'b'.repeat(56), 'c'.repeat(64), 'd'.repeat(65), 'long-data-'.repeat(1000)];
    for (const value of vectors) {
      expect(sha256Utf8(value)).toBe(createHash('sha256').update(value, 'utf8').digest('hex'));
    }
  });

  it('bundles the catalogs public entry for a browser without Node builtins', async () => {
    // what_bug_this_catches: importing the resolver through the public catalogs entry pulling server-only translation workflow code.
    const build = await loadInstalledEsbuild();
    const result = await build({
      entryPoints: [resolve(root, 'packages/i18n/src/catalogs.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.outputFiles.length).toBeGreaterThan(0);
    const output = result.outputFiles.map(file => file.text).join('\n');
    expect(output).toContain('resolveCatalogMessage');
    expect(output).not.toMatch(/node:(?:crypto|fs|path)/u);
    expect(Object.keys(result.metafile?.inputs ?? {}).some(path => /translation-(?:workflow|postgres)/u.test(path))).toBe(false);
  }, 15_000);

  it('bundles the migrated translation workbench for a browser through the public catalogs entry', async () => {
    // what_bug_this_catches: a browser-safe resolver existing in isolation while its first product consumer pulls a server-only entry.
    const build = await loadInstalledEsbuild();
    const result = await build({
      entryPoints: [resolve(root, 'apps/web/app/translate/workbench.tsx')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime'],
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(result.outputFiles.length).toBeGreaterThan(0);
    const output = result.outputFiles.map(file => file.text).join('\n');
    expect(output).toContain('resolveCatalogMessage');
    expect(output).toContain('data-i18n-affordance');
    expect(output).not.toMatch(/node:(?:crypto|fs|path)/u);
    expect(Object.keys(result.metafile?.inputs ?? {}).some(path => /translation-(?:workflow|postgres)/u.test(path))).toBe(false);
  }, 15_000);

  it('keeps the browser runtime free of Node builtins and unsafe HTML transformation', async () => {
    // what_bug_this_catches: a client import pulling node:crypto/fs into the browser or interpreting catalog text as markup.
    const source = await readFile(resolve(root, 'packages/i18n/src/catalog-resolver.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]node:/u);
    expect(source).not.toContain('innerHTML');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
