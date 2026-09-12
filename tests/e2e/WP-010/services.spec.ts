import { expect, test } from '@playwright/test';
import { createDatabaseClient } from '../../../packages/db/src/index.ts';

test.use({ javaScriptEnabled: false });

const liveDatabaseUrl = process.env.WP010_E2E_DATABASE_URL;
const orgId = '11111111-1111-4111-8111-111111111111';
const actorId = '11111111-1111-4111-8111-111111111101';
let database: ReturnType<typeof createDatabaseClient> | undefined;

test.beforeAll(async () => {
  if (!liveDatabaseUrl) return;
  database = createDatabaseClient(liveDatabaseUrl);
  await database.unsafe(`
    insert into orgs (id,name,slug) values ('${orgId}','E2E North','e2e-north') on conflict do nothing;
    insert into users (id,org_id,display_name) values ('${actorId}','${orgId}','E2E directory reviewer') on conflict do nothing;
    insert into service_categories (id,org_id,slug,label_en,label_es) values
      ('11111111-1111-4111-8111-111111111141','${orgId}','food','Food','Comida') on conflict do nothing;
    insert into services (id,org_id,external_id,category_id,name_en,name_es,description_en,description_es,
      eligibility_note_en,eligibility_note_es,phone,source_updated_at,publication_state,reviewed_by,reviewed_at)
    values ('11111111-1111-4111-8111-111111111151','${orgId}','meal-e2e',
      '11111111-1111-4111-8111-111111111141','Home-delivered meals','Comidas a domicilio',
      'Fresh meal delivery at home','Entrega de comidas frescas a domicilio','','','555-0110',
      '2026-09-10T12:00:00Z','published','${actorId}','2026-09-10T12:00:00Z') on conflict do nothing;
  `);
});

test.afterAll(async () => { await database?.end(); });

test('a resident can submit a plain-language directory search without client JavaScript @smoke', async ({ page }) => {
  await page.goto('/services');
  await page.getByLabel('What kind of help are you looking for?').fill('meal delivery');
  await page.getByRole('button', { name: 'Search services' }).click();
  await expect(page).toHaveURL(/\/services\?q=meal(?:\+|%20)delivery/u);
  if (liveDatabaseUrl) {
    await expect(page.getByRole('heading', { name: 'Home-delivered meals' })).toBeVisible();
    await expect(page.locator('p').filter({ hasText: 'Source updated:' })).toContainText('2026-09-10');
  } else {
    await expect(page.getByRole('alert')).toContainText('directory is unavailable');
  }
});

test('the service search follows the persistent Spanish preference @smoke', async ({ context, page }) => {
  await page.goto('/services');
  await context.addCookies([{ name: 'seniorsocial.locale.v1', value: 'es', url: page.url() }]);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Encuentre servicios locales' })).toBeVisible();
  await page.getByLabel('¿Qué tipo de ayuda busca?').fill('comida');
  await page.getByRole('button', { name: 'Buscar servicios' }).click();
  if (liveDatabaseUrl) {
    await expect(page.getByRole('heading', { name: 'Comidas a domicilio' })).toBeVisible();
    await expect(page.locator('p').filter({ hasText: 'Fuente actualizada:' })).toContainText('2026-09-10');
  } else {
    await expect(page.getByRole('alert')).toContainText('directorio no está disponible');
  }
});
