import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for (const locale of ['en', 'es'] as const) {
  test(`@smoke WP-016 ${locale} real messaging, report, block and accessible keyboard status`, async ({ page, context, browser }) => {
    const browserErrors: string[] = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') browserErrors.push(entry.text()); });
    const sender = locale === 'en' ? '11' : '21'; const recipient = locale === 'en' ? '12' : '22';
    await context.addCookies([
      { name: 'ss_session', value: `wp016-browser-${sender}`, url: 'http://localhost:3166' },
      { name: 'seniorsocial.locale.v1', value: locale, url: 'http://localhost:3166' },
      { name: 'seniorsocial.display-mode.v1', value: 'easy', url: 'http://localhost:3166' },
    ]);
    await page.goto('/messages');
    await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeVisible();
    const ordinaryRenderState = locale === 'es' ? 'provisional_english_fallback' : 'english_source';
    const ordinaryAffordance = 'Spanish translation is awaiting review.';
    async function expectOrdinary(key: string, text: string) {
      const value = page.locator(`[data-catalog-key="${key}"][data-catalog-render-state]`).first();
      await expect(value).toHaveText(text);
      await expect(value).toHaveAttribute('lang', 'en');
      await expect(value).toHaveAttribute('data-catalog-render-state', ordinaryRenderState);
      const affordances = page.locator(`[data-catalog-key="${key}"][data-catalog-affordance]`);
      if (locale === 'es') {
        expect(await affordances.count()).toBeGreaterThan(0);
        for (const affordance of await affordances.all()) {
          await expect(affordance).toHaveText(ordinaryAffordance);
          await expect(affordance).toHaveAttribute('lang', 'en');
        }
      } else await expect(affordances).toHaveCount(0);
    }
    await expectOrdinary('page.title', 'Messages');
    await expectOrdinary('conversation.start', 'Start a conversation');
    await expectOrdinary('conversation.participant_label', 'Community member ID');
    await expectOrdinary('conversation.create', 'Open conversation');
    await expectOrdinary('navigation.notification_preferences', 'Notification preferences');
    if (locale === 'es') {
      await expect(page.locator('h1 + [data-catalog-key="page.title"][data-catalog-affordance]')).toHaveText(ordinaryAffordance);
      await expect(page.locator('button + [data-catalog-key="conversation.create"][data-catalog-affordance]')).toHaveText(ordinaryAffordance);
      await expect(page.locator('a + [data-catalog-key="navigation.notification_preferences"][data-catalog-affordance]')).toHaveText(ordinaryAffordance);
    }
    const criticalRenderState = locale === 'es' ? 'held_english_fallback' : 'english_source';
    const privacy = page.locator('[data-catalog-key="privacy.participant_only"][data-catalog-render-state]');
    await expect(privacy).toHaveText('Only the two participants can read these messages. Notifications never include message text.');
    await expect(privacy).toHaveAttribute('lang', 'en');
    await expect(privacy).toHaveAttribute('data-catalog-render-state', criticalRenderState);
    const privacyAffordance = page.locator('[data-catalog-key="privacy.participant_only"][data-catalog-affordance]');
    if (locale === 'es') {
      await expect(privacyAffordance).toHaveText('available in English only');
      await expect(privacyAffordance).toHaveAttribute('lang', 'en');
      await expect(page.getByText('Solo usted y la otra persona pueden leer estos mensajes.', { exact: false })).toHaveCount(0);
    } else await expect(privacyAffordance).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Loading…' }), JSON.stringify(browserErrors)).toHaveCount(0, { timeout: 15000 });
    await expectOrdinary('conversation.empty', 'No conversations yet.');
    await page.getByLabel('Community member ID', { exact: true }).fill(`10000000-0000-4000-8000-0000000000${recipient}`);
    const creation = page.waitForResponse(response => response.url().endsWith('/api/v1/conversations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Open conversation', exact: true }).click();
    expect((await creation).status()).toBe(201);
    const editor = page.getByLabel('Your message', { exact: true });
    await expect(editor).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Messages', exact: true })).toBeFocused();
    for (const [key, text] of [
      ['conversation.open', 'Open'],
      ['conversation.label', 'Conversation'],
      ['navigation.back_to_conversations', 'Back to conversations'],
      ['conversation.refresh', 'Refresh messages'],
      ['composer.body_label', 'Your message'],
      ['composer.send', 'Send message'],
    ] as const) await expectOrdinary(key, text);
    const body = `WP016 ${locale} <script>inert private text</script>`;
    const sendKeys: string[] = [];
    let failFirstSend = true;
    await page.route('**/api/v1/conversations/*/messages', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      sendKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (failFirstSend) {
        failFirstSend = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"retry"}' });
        return;
      }
      await route.continue();
    });
    await editor.fill(body); await editor.press('Tab');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'The action was not confirmed.' })).toBeVisible();
    await expectOrdinary('error.retry', 'The action was not confirmed. Retry with the same text to avoid duplicates.');
    await expect(editor).toHaveValue(body);
    const sentResponse = page.waitForResponse(response => response.url().endsWith('/messages') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    expect((await sentResponse).status()).toBe(201);
    await page.unroute('**/api/v1/conversations/*/messages');
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[0]).not.toBe('');
    expect(sendKeys[1]).toBe(sendKeys[0]);
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Message sent.' })).toBeVisible();
    await expectOrdinary('state.sent', 'Message sent.');
    await expect(editor).toBeFocused();
    const reportReason = page.locator('[data-catalog-key="report.reason_label"][data-catalog-render-state]');
    await expect(reportReason).toHaveText('Reason for your report');
    await expect(reportReason).toHaveAttribute('lang', 'en');
    await expect(reportReason).toHaveAttribute('data-catalog-render-state', criticalRenderState);
    await page.getByLabel('Reason for your report').fill('Please review / Revisar');
    const reportKeys: string[] = [];
    let failFirstReport = true;
    await page.route('**/api/v1/conversations/*/report', async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      reportKeys.push(route.request().headers()['idempotency-key'] ?? '');
      if (failFirstReport) {
        failFirstReport = false;
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"retry"}' });
        return;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: 'Report to a person', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'The action was not confirmed.' })).toBeVisible();
    const reportedResponse = page.waitForResponse(response => response.url().endsWith('/report') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Report to a person', exact: true }).click();
    expect((await reportedResponse).status()).toBe(201);
    await page.unroute('**/api/v1/conversations/*/report');
    expect(reportKeys).toHaveLength(2);
    expect(reportKeys[0]).not.toBe('');
    expect(reportKeys[1]).toBe(reportKeys[0]);
    const reportedStatus = page.getByRole('status').filter({ hasText: 'Your report is saved' });
    await expect(reportedStatus).toBeVisible();
    await expect(reportedStatus.locator('[data-catalog-key="report.saved"][data-catalog-render-state]')).toHaveAttribute('lang', 'en');
    if (locale === 'es') {
      await expect(reportedStatus.locator('[data-catalog-key="report.saved"][data-catalog-affordance]')).toHaveText('available in English only');
      for (const key of ['report.heading', 'report.reason_label', 'report.note_label', 'block.action', 'block.help']) {
        await expect(page.locator(`[data-catalog-key="${key}"][data-catalog-affordance]`).first()).toHaveText('available in English only');
      }
    }
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(accessibility.violations).toEqual([]);
    const recipientContext = await browser.newContext();
    await recipientContext.addCookies([{ name: 'ss_session', value: `wp016-browser-${recipient}`, url: 'http://localhost:3166' }]);
    const other = await recipientContext.newPage(); await other.goto('http://localhost:3166/messages');
    await other.getByRole('button', { name: 'Open Conversation 1', exact: true }).click();
    await expect(other.getByText(body, { exact: true })).toBeVisible();
    // Reopen from the list before the privacy action: confirms the retained
    // conversation remains readable after reporting and after a fresh navigation.
    await page.getByRole('button', { name: 'Open Conversation 1', exact: true }).click();
    await expect(page.getByText(body, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Block this person', exact: true }).click();
    await expect(page.getByText(body, { exact: true })).toHaveCount(0);
    const blockedStatus = page.getByRole('status').filter({ hasText: 'Person blocked.' });
    await expect(blockedStatus).toBeVisible();
    await expect(blockedStatus.locator('[data-catalog-key="block.saved"][data-catalog-render-state]')).toHaveAttribute('lang', 'en');
    if (locale === 'es') await expect(blockedStatus.locator('[data-catalog-key="block.saved"][data-catalog-affordance]')).toHaveText('available in English only');
    await other.getByRole('button', { name: 'Refresh messages' }).click();
    await expect(other.getByText(body, { exact: true })).toHaveCount(0);
    await expect(other.getByLabel('Your message')).toHaveCount(0);
    await recipientContext.close();
  });
}
