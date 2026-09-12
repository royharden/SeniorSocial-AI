import { expect, test } from '@playwright/test';
import { caregiver, fixture, linkId, rawToken, resident } from '../../unit/WP-017/fixture.ts';

test('@smoke resident consent survives as exact authority and revoke stops the next caregiver request', async ({ page }) => {
  // what_bug_this_catches: the happy-path screens work while enforcement still treats the invite as a broad standing grant.
  await page.goto('/caregiver');
  await expect(page.getByRole('heading', { name: 'Caregiver access' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke all caregiver access' })).toBeVisible();
  await expect(page.getByText(/receives only the permissions selected here/iu)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /manage events/iu })).toHaveCount(0);
  const journey = fixture();
  await journey.service.invite(resident, { email_or_phone: 'helper@example.invalid' });
  await journey.service.accept(caregiver, rawToken);
  await journey.service.setScopes(resident, linkId, { read_back_confirmed: true, scopes: [
    { key: 'view_schedule', granted: true }, { key: 'view_assistance', granted: false },
  ] });
  await expect(journey.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).resolves.toBe(true);
  await expect(journey.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'assistance', action: 'read' })).resolves.toBe(false);
  await journey.service.revoke(resident, linkId);
  await expect(journey.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).resolves.toBe(false);
});
