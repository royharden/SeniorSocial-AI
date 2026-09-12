import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createDatabaseClient } from '../../../packages/db/src/index';
import { digestSecret } from '../../../packages/auth/src/crypto';

const token = 'synthetic-completion-browser-session'; // secrets-scan: allow — deterministic local fixture
const org = '11111111-1111-4111-8111-111111111111';
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// Next dev identifies its local origin as localhost; use that origin for live
// client hydration instead of bypassing its cross-origin HMR protection.
const webUrl = process.env.WP009_WEB_URL ?? 'http://localhost:3110';
test.use({ baseURL: webUrl });
// These live dev-server tests include first compilation of the new server routes.
// Keep those cold-build waits separate from any production journey performance gate.
test.setTimeout(120000);
test.beforeAll(async () => {
  const url = process.env.WP009_COMPLETION_DATABASE_URL;
  if (!url || new URL(url).pathname !== '/seniorsocial_wp009_completion_test') throw new Error('Run completion DB fixture first; dedicated WP009_COMPLETION_DATABASE_URL required');
  const sql = createDatabaseClient(url);
  try {
    await sql`insert into sessions(org_id,user_id,token_digest,expires_at) values (${org},${user},${digestSecret(token,'synthetic-completion-pepper')},now()+interval '1 hour') on conflict (org_id,token_digest) do update set revoked_at=null, expires_at=excluded.expires_at`;
  } finally { await sql.end(); }
});

// what_bug_this_catches: authenticated settings fail in the actual shell, lose task choices,
// or render undersized Easy Mode controls; print silently replaces source provenance.
test('@smoke resident saves shared-device settings and opens versioned print in Easy Mode', async ({page,context}) => {
  await context.addCookies([{name:'ss_session',value:token,url:webUrl}, {name:'seniorsocial.display-mode.v1',value:'easy',url:webUrl}]);
  await page.goto('/settings/notifications');
  await expect(page.getByRole('button',{name:'Save notification settings'})).toBeVisible({timeout:45000});
  await page.getByLabel('I share this phone or device').check();
  await page.getByRole('button',{name:'Save notification settings'}).click();
  await expect(page.getByRole('status').last()).toContainText('Notification settings saved.');
  await page.reload();
  await expect(page.getByLabel('I share this phone or device')).toBeChecked();
  const taskGroup = page.getByRole('group',{name:'task notice',exact:true});
  await expect(taskGroup.getByLabel('sms',{exact:true})).toBeChecked();
  const button = await page.getByRole('button',{name:'Save notification settings'}).boundingBox();
  expect(button!.height).toBeGreaterThanOrEqual(48);
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);
  await page.getByRole('link',{name:'Open printable schedule'}).click();
  await expect(page.getByText(/^Source version: schedule:no-connected-sources:v1:/)).toBeVisible({timeout:45000});
  await expect(page.getByText('No schedule sources are available yet. This is not confirmation that you have no upcoming plans.')).toBeVisible();
  const sourceTime = await page.locator('time').getAttribute('datetime');
  expect(Date.parse(sourceTime!)).toBeLessThanOrEqual(Date.now());
  expect(Date.now()-Date.parse(sourceTime!)).toBeLessThan(120000);
  const popup = context.waitForEvent('page');
  await page.getByRole('link',{name:'Open a freshly authorized print view'}).click();
  const print = await popup;
  await expect(print.getByRole('heading',{name:'Printable schedule'})).toBeVisible();
  await expect(print.getByText(/^Source version: schedule:no-connected-sources:v1:/)).toBeVisible();
  await expect(print.getByText(/not confirmation that you have no upcoming plans/)).toBeVisible();
  await expect(print.getByText(/do not update or recall/)).toBeVisible();
});

// what_bug_this_catches: unauthenticated pages expose a resident's cached snapshot or preferences.
test('@smoke anonymous notification and print pages disclose no resident data', async ({page}) => {
  await page.goto('/settings/notifications');
  await expect(page.getByRole('status').last()).toContainText('unavailable',{timeout:45000});
  await expect(page.getByRole('button',{name:'Save notification settings'})).toHaveCount(0);
  await page.goto('/print');
  await expect(page.getByRole('status').last()).toContainText('No printable source is available',{timeout:45000});
  await expect(page.getByText('Synthetic community lunch')).toHaveCount(0);
});
