import { expect, test } from '@playwright/test';

test('@smoke resident can use localized concierge and must confirm human handoff', async ({ page }) => {
  test.setTimeout(30_000);
  const conversationId = '66666666-6666-4666-8666-666666666611';
  await page.route('**/api/v1/concierge/conversations', route => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: conversationId, turns: [], ai_enabled: true }) }));
  await page.route(`**/api/v1/concierge/conversations/${conversationId}/messages`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'No lo sé según los registros autorizados del directorio.', citations: [], disclaimer: 'La información del directorio puede cambiar.', human_route: '/assistance', prompt_version: 'native-v1' }) }));
  await page.route(`**/api/v1/concierge/conversations/${conversationId}/handoff`, route => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '66666666-6666-4666-8666-666666666612', org_id: '66666666-6666-4666-8666-666666666666', state: 'pending_unowned' }) }));
  await page.goto('/concierge');
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByLabel('What service are you looking for?')).toBeVisible();
  await page.getByRole('button', { name: 'Español' }).click();
  await expect(page.getByRole('heading', { name: 'Conserjería de servicios' })).toBeVisible();
  await page.getByLabel('¿Qué servicio busca?').fill('ayuda con comidas');
  await page.getByRole('button', { name: 'Preguntar' }).click();
  await expect(page.getByText('No lo sé según los registros autorizados del directorio.')).toBeVisible();
  const handoff = page.getByRole('button', { name: 'Hablar con una persona' });
  await expect(handoff).toBeDisabled();
  await page.getByLabel('Confirmo que quiero crear una solicitud de asistencia.').check();
  await handoff.click();
  await expect(page.getByRole('status')).toContainText('Se creó su solicitud de asistencia.');
});
