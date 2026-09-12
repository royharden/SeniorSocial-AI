import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FilePromptRegistry, FileRouter } from '../../../packages/ai/src/config.ts';
import { generateOpenApiDocument } from '../../../packages/contracts/src/index.ts';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs.ts';
import { GET as getReport } from '../../../apps/web/app/api/v1/admin/reports/[reportName]/route.ts';
import { POST as createExport } from '../../../apps/web/app/api/v1/admin/exports/route.ts';
import { GET as getExport } from '../../../apps/web/app/api/v1/admin/exports/[exportId]/route.ts';
import { GET as downloadExport } from '../../../apps/web/app/api/v1/admin/exports/[exportId]/download/route.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFile(join(root, path), 'utf8');
const requiredDocs = [
  'docs/architecture.md', 'docs/data-model.md', 'docs/api.md', 'docs/security-plan.md',
  'docs/ai-register.md', 'docs/accessibility.md',
] as const;
const features = [
  'concierge', 'moderation', 'translation_assist', 'triage', 'intake_routing',
  'event_rerank', 'conversation_starters', 'summaries',
] as const;

describe('WP-035 source-grounded documentation contract', () => {
  test('required topology exists and each technical document gives anchors and honest status', async () => {
    for (const path of requiredDocs) {
      expect((await stat(join(root, path))).isFile(), path).toBe(true);
      const text = await read(path);
      expect(text, `${path} source anchors`).toMatch(/## Source anchors/i);
      expect(text, `${path} status`).toMatch(/Status:/i);
      expect(text, `${path} gap language`).toMatch(/gap|hardening|not release-ready|release assurance/i);
    }
  });

  test('AI register covers the closed contract, current registry, routing, callers, authority, and switches', async () => {
    const [contract, registryText, routingText, register, migration] = await Promise.all([
      read('packages/contracts/gateway-interface.ts'), read('packages/ai/prompts/registry.json'),
      read('packages/ai/routing.json'), read('docs/ai-register.md'),
      read('packages/db/migrations/0030_wp-006_audit_flags.sql'),
    ]);
    const registry = JSON.parse(registryText) as Record<string, { version: string; file: string }>;
    const routing = JSON.parse(routingText) as Record<string, { provider: string; model: string }>;
    expect(Object.keys(registry).sort()).toEqual([...features].sort());
    expect(Object.keys(routing).sort()).toEqual([...features].sort());
    const rows = [...register.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]);
    expect(rows.sort()).toEqual([...features].sort());
    const prompts = new FilePromptRegistry(join(root, 'packages/ai'));
    const router = await new FileRouter(join(root, 'packages/ai'), 'stub').load();
    for (const feature of features) {
      expect(contract, `${feature} contract`).toContain(`'${feature}'`);
      expect(registry[feature]?.version, `${feature} prompt`).toMatch(/^v\d+$/);
      expect(await stat(join(root, 'packages/ai/prompts', registry[feature]!.file))).toBeTruthy();
      expect(routing[feature]?.model, `${feature} route`).toBeTruthy();
      expect(migration, `${feature} flag`).toContain(`'ai.${feature}'`);
      expect(register, `${feature} register row`).toContain(`\`${feature}\``);
      const promptText = await read(`packages/ai/prompts/${registry[feature]!.file}`);
      const prompt = await prompts.get(feature);
      expect(prompt.ref).toEqual({ feature, version: 'v1', hash: createHash('sha256').update(promptText).digest('hex') });
      expect(routing[feature]).toMatchObject({ provider: 'anthropic-api', model: 'claude-haiku-4-5' });
      expect(router.route(feature)).toMatchObject({ provider: 'stub', model: 'test-stub' });
    }
    expect(register).toMatch(/Human authority/i);
    expect(register).toMatch(/Integrated caller/i);
    expect(register).toMatch(/AI-off route/i);
    expect(register).toMatch(/false everywhere|off in every environment/i);
  });

  test('register defaults match the executable environment matrix', async () => {
    const migration = await read('packages/db/migrations/0030_wp-006_audit_flags.sql');
    const register = await read('docs/ai-register.md');
    const matrix = new Map([...migration.matchAll(/\('ai\.([^']+)', (true|false), (true|false), (true|false), (true|false)\)/g)]
      .map(match => [match[1], match.slice(2).map(value => value === 'true')]));
    for (const feature of ['master', ...features.slice(0, 5)]) {
      expect(matrix.get(feature), feature).toEqual([true, false, true, true]);
    }
    for (const feature of features.slice(5)) expect(matrix.get(feature), feature).toEqual([false, false, false, false]);
    expect(register).toContain('true in dev/staging/production and false in test');
    expect(register).not.toMatch(/dev only|test\/staging\/production off|off elsewhere/);
  });

  test('documents the actual stub-only compositions rather than paid provider readiness', async () => {
    const register = await read('docs/ai-register.md');
    expect(register).toContain('Anthropic adapter is package-only');
    expect(register).toContain('cacheable: false');
    for (const path of [
      'apps/web/app/api/v1/concierge/_runtime.ts',
      'apps/web/app/api/v1/forums/_runtime.ts',
      'apps/web/app/api/v1/admin/translations/_shared.ts',
    ]) {
      const runtime = await read(path);
      expect(runtime, path).toContain("new FileRouter(undefined, 'stub')");
      expect(runtime, path).toContain("providers: new Map([['stub',");
      expect(runtime, path).toMatch(/cacheable:\s*false/);
      expect(runtime, path).not.toContain('new AnthropicProviderAdapter');
    }
  });

  test('the documented OpenAPI adapter inventory matches the route tree and live methods', async () => {
    const api = await read('docs/api.md');
    const contract = generateOpenApiDocument() as unknown as {
      readonly paths: Record<string, Record<string, unknown>>;
    };
    const declared = Object.keys(contract.paths);
    const missing: string[] = [];
    for (const path of declared) {
      const route = path.replace(/\{([^}]+)\}/g, '[$1]');
      try { await stat(join(root, `apps/web/app/api/v1${route}/route.ts`)); }
      catch { missing.push(path); }
    }
    expect(missing.sort()).toEqual([
      '/healthz', '/readyz', '/auth/magic-link', '/auth/sms-code', '/auth/verify',
      '/auth/demo-code', '/auth/logout', '/me', '/me/profile',
    ].sort());
    for (const path of missing.filter(path => !path.startsWith('/auth/'))) expect(api).toContain(`\`${path}\``);
    for (const path of missing.filter(path => path.startsWith('/auth/'))) {
      expect(await stat(join(root, `apps/web/app/(auth)${path}/route.ts`))).toBeTruthy();
    }
    for (const [path, method, handler] of [
      ['/admin/reports/{reportName}', 'get', getReport],
      ['/admin/exports', 'post', createExport],
      ['/admin/exports/{exportId}', 'get', getExport],
      ['/admin/exports/{exportId}/download', 'get', downloadExport],
    ] as const) {
      expect(contract.paths[path], `${method.toUpperCase()} ${path} OpenAPI operation`).toHaveProperty(method);
      expect(handler, `${method.toUpperCase()} ${path} route export`).toBeTypeOf('function');
      expect(api, `${path} documented live adapter`).toContain(`\`${path}\``);
    }
  });

  test('quick-start instructions use real controls and disclose missing workflow screens', async () => {
    const [resident, caregiver, staff, index, servicePage, caregiverPage, dashboard, shell] = await Promise.all([
      read('docs/quick-start/resident.md'), read('docs/quick-start/caregiver.md'),
      read('docs/quick-start/staff-admin.md'), read('docs/quick-start/README.md'),
      read('apps/web/app/services/page.tsx'), read('apps/web/app/(shell)/caregiver/page.tsx'),
      read('apps/web/app/(shell)/admin/admin-dashboard.tsx'), read('packages/ui/src/app-shell.tsx'),
    ]);
    expect(servicePage).toContain("resolveCatalogMessage, type CatalogKey, type CatalogResolution");
    expect(servicePage).toContain("namespace: 'services'");
    for (const key of ['directory.heading', 'directory.search_label', 'directory.search_action'] as const) {
      expect(servicePage).toContain(`serviceMessage(locale, '${key}')`);
      const resolution = resolveCatalogMessage({ locale: 'en', namespace: 'services', key });
      expect(resolution.found, key).toBe(true);
      expect(resident, key).toContain(resolution.text);
    }
    expect(caregiverPage).toContain("resolveMessage({ locale, namespace: 'caregiver', key })");
    for (const key of ['consent.link_id', 'consent.save', 'consent.revoke'] as const) {
      expect(caregiverPage).toContain(`message('${key}')`);
      expect(resolveCatalogMessage({ locale: 'en', namespace: 'caregiver', key }).found, key).toBe(true);
    }
    expect(caregiver).toContain('caregiver link ID');
    expect(caregiver).toContain('exact permissions');
    expect(caregiver).toContain('Revoke all caregiver access');
    expect(caregiver).toContain('no acceptance page or resident chooser');
    expect(staff).toContain('no feature-flag control screen');
    expect(staff).toContain('moderation decision buttons');
    expect(dashboard).toContain("message(resolveMessage, locale, 'page.title')");
    const dashboardTitle = resolveCatalogMessage({ locale: 'en', namespace: 'admin', key: 'page.title' });
    expect(dashboardTitle.found).toBe(true);
    expect(staff).toContain(dashboardTitle.text);
    expect(shell).toContain('<a href="/help">{text.call}</a>');
    expect(index).toContain('does not start a phone call');
    expect(index).toContain('200%');
    expect(resident).not.toContain('Talk to a person');
    expect(resident).toContain('no sign-out button');
    expect(resident).toContain('Do not use it on a shared device');
  });

  test('architecture, data, API and security docs cite executable source families', async () => {
    const combined = (await Promise.all([
      read('docs/architecture.md'), read('docs/data-model.md'), read('docs/api.md'), read('docs/security-plan.md'),
    ])).join('\n');
    for (const anchor of [
      'agentops/interfaces/openapi.yaml', 'packages/db/migrations', 'packages/db/src/tenant.ts',
      'packages/contracts/gateway-interface.ts', 'packages/ai/src/gateway.ts', 'tests/security',
    ]) expect(combined, anchor).toContain(anchor);
    expect(await stat(join(root, 'agentops/interfaces/openapi.yaml'))).toBeTruthy();
    expect((await readdir(join(root, 'packages/db/migrations'))).some(name => name.endsWith('.sql'))).toBe(true);
  });

  test('large-print guides are role-specific, plain, and preserve non-AI paths', async () => {
    const names = await readdir(join(root, 'docs/quick-start'));
    expect(names.sort()).toEqual(['README.md', 'caregiver.md', 'resident.md', 'staff-admin.md'].sort());
    const guides = await Promise.all(names.map(name => read(`docs/quick-start/${name}`)));
    for (const text of guides) {
      expect(text).toMatch(/LARGE-PRINT/);
      expect(text).toMatch(/AI|larger|zoom/i);
    }
    const all = guides.join('\n');
    expect(all).toMatch(/AI (?:helper )?is unavailable/i);
    expect(all).toMatch(/Talk to a person|Call a person|human queue/i);
    expect(all).toMatch(/Easy Mode|Choose \*\*Easy\*\*/i);
  });

  test('accessibility documentation is tied to shipped tokens and behavioral coverage', async () => {
    const [doc, theme, keyboard, axe] = await Promise.all([
      read('docs/accessibility.md'), read('packages/tokens/theme.css'),
      read('tests/a11y/WP-031/keyboard-layout.spec.ts'), read('tests/a11y/WP-031/axe.spec.ts'),
    ]);
    expect(theme).toContain('--ss-target: 3rem');
    for (const concept of ['48px', 'keyboard', 'focus', 'live announcements', 'reduced-motion', 'screen-reader']) {
      expect(doc.toLowerCase()).toContain(concept.toLowerCase());
    }
    expect(keyboard).toContain('48x48 CSS pixels');
    expect(axe).toContain('AxeBuilder');
  });
});
