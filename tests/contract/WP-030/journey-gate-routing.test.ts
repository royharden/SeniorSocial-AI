import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../../../', import.meta.url);
const packageJson = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  scripts: Record<string, string>;
};
const playwrightConfig = readFileSync(new URL('playwright.config.ts', root), 'utf8');

describe('WP-030 journey gate routing', () => {
  it('excludes disposable-cluster journeys from root smoke and full E2E discovery', () => {
    expect(playwrightConfig).toContain("testIgnore: '**/e2e/journeys/**'");
    expect(packageJson.scripts['verify:e2e:changed']).toContain('playwright test tests/e2e');
    expect(packageJson.scripts['verify:full:e2e']).toContain('playwright test tests/e2e');
  });

  it('routes full journeys only through their dedicated guarded configuration', () => {
    const command = packageJson.scripts['verify:e2e:journeys'];
    expect(command).toContain('--dir tests/e2e/journeys');
    expect(command).toContain('--config tests/e2e/journeys/playwright.config.ts');
    expect(packageJson.scripts['verify:full']).toContain('pnpm verify:e2e:journeys');
  });
});
