import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('@smoke demo guide contains a complete cold-run and two-run convergence check', async () => {
  // what_bug_this_catches: a reviewer document assuming hidden setup knowledge or never proving reset convergence.
  const guide = await readFile(new URL('../../../docs/demo-script.md', import.meta.url), 'utf8');
  for (const command of ['pnpm install --frozen-lockfile', 'db:migrate', 'db:seed', 'seed/demo/run.ts', 'DEMO-SENIOR', 'DEMO-ADMIN']) {
    expect(guide).toContain(command);
  }
  expect(guide.match(/seed\/demo\/run\.ts/gu)).toHaveLength(3);
  expect(guide).toContain('http://localhost:3100');
  expect(guide).toContain('under 120000');
});
