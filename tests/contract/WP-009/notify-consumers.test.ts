import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');

describe('WP-009 approval-aware notify consumers', () => {
  // what_bug_this_catches: the UI reintroduces raw EN/ES object selection or hardcoded notification labels.
  it.each([
    'apps/web/app/(shell)/settings/notifications/page.tsx',
    'apps/web/app/(shell)/print/page.tsx',
  ])('uses the public resolver and exposes per-value render provenance in %s', async file => {
    const source = await readFile(resolve(root, file), 'utf8');
    expect(source).toContain("from '@seniorsocial/i18n/catalogs'");
    expect(source).toContain('resolveCatalogMessage');
    expect(source).toContain("namespace: 'notify'");
    expect(source).toContain('data-render-state');
    expect(source).toContain('data-review-status');
    expect(source).toContain('data-catalog-affordance');
    expect(source).not.toMatch(/packages\/i18n\/(?:en|es)\/notify\.json/u);
    expect(source).not.toContain('Configuración de notificaciones');
    expect(source).not.toContain('Horario para imprimir');
  });

  // what_bug_this_catches: delivery rendering regresses to local language literals outside the governed resolver.
  it('routes runtime and shared-device bodies through one catalog artifact', async () => {
    const runtime = await readFile(resolve(root, 'packages/notify/src/runtime.ts'), 'utf8');
    const service = await readFile(resolve(root, 'packages/notify/src/service.ts'), 'utf8');
    expect(runtime).toContain('minimalNotificationArtifact(job.payload.locale).body');
    expect(service).toContain('minimalNotificationArtifact(job.payload.locale).body');
    expect(`${runtime}\n${service}`).not.toContain('Tiene una nueva notificación');
  });
});
