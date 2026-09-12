import { expect, test } from '@playwright/test';

test('resident browses, RSVPs and submits an unpublished proposal @smoke', async ({ page }) => {
  const webUrl = process.env.WP012_WEB_URL ?? 'http://localhost:3110';
  const eventId = '10000000-0000-4000-8000-000000000031';
  await page.route('**/api/v1/recommendations/events', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    items: [{ id: eventId, org_id: '10000000-0000-4000-8000-000000000001', title: 'Community lunch',
      starts_at: '2026-09-20T16:00:00.000Z', time_zone: 'America/New_York', location: 'Civic Hall', capacity: 20, rsvp_count: 4, accessibility: ['step-free'] }],
    meta: { next_cursor: null, total_known: true }, reasons: { [eventId]: 'Matches step-free' },
  }) }));
  await page.route(`**/api/v1/events/${eventId}/rsvp`, route => route.fulfill({ status: 201, contentType: 'application/json',
    body: JSON.stringify({ id: '10000000-0000-4000-8000-000000000041', event_id: eventId, state: 'attending' }) }));
  let proposalBody: unknown;
  await page.route('**/api/v1/event-proposals', async route => {
    proposalBody = route.request().postDataJSON() as unknown;
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '10000000-0000-4000-8000-000000000051', state: 'proposed' }) });
  });

  // Next advertises localhost; using the same host keeps its dev-origin guard
  // from blocking hydration while the test server is bound to loopback.
  await page.goto(`${webUrl}/events`);
  await expect(page.getByRole('heading', { name: 'Community lunch' })).toBeVisible();
  await expect(page.getByText('Matches step-free')).toBeVisible();
  await page.getByRole('button', { name: 'Attend this event', exact: true }).click();
  await expect(page.getByRole('status').last()).toContainText('You are marked as attending.');
  await expect(page.getByRole('status').last()).toContainText('Check the event details again before you go.');

  await page.getByLabel('Event title').fill('Chess afternoon');
  await page.getByLabel('Date and time').fill('2026-09-21T18:00');
  await page.getByLabel('Why would this event help the community?').fill('Beginner tables welcome');
  await page.getByRole('button', { name: 'Send suggestion' }).click();
  await expect(page.getByRole('status').last()).toContainText('Suggestion sent for staff review. It is not published yet.');
  expect(proposalBody).toMatchObject({ title: 'Chess afternoon', time_zone: 'America/New_York', note: 'Beginner tables welcome' });
});
