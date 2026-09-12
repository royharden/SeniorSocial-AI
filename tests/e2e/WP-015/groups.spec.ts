import { expect, test } from '@playwright/test';

test('resident posts, replies, reports, and blocks from the group surface @smoke',async({page})=>{
  const webUrl=process.env.WP015_WEB_URL??'http://localhost:3110';const topic='11111111-1111-4111-8111-111111111111';const author='22222222-2222-4222-8222-222222222222';const post='33333333-3333-4333-8333-333333333333';
  let posts=[{id:post,author_id:author,body:'Anyone for a morning walk?',flag_state:'none'}];let reported=false,blocked=false,replied=false;
  const publishedBodies:string[]=[];let replyBody:unknown;let reportBody:unknown;let blockBody:unknown;
  await page.route('**/api/v1/forums/topics',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:[{id:topic,title:'Neighbors',post_count:posts.length}],meta:{next_cursor:null,total_known:true}})}));
  await page.route(`**/api/v1/forums/topics/${topic}/posts`,async route=>{if(route.request().method()==='POST'){const input=route.request().postDataJSON() as {body:string};publishedBodies.push(input.body);if(publishedBodies.length===2){await route.fulfill({status:429,contentType:'application/json',body:'{}'});return;}posts=[...posts,{id:'44444444-4444-4444-8444-444444444444',author_id:author,body:input.body,flag_state:'none'}];await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify(posts.at(-1))});}else await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({items:posts,meta:{next_cursor:null,total_known:true}})});});
  await page.route(`**/api/v1/forums/posts/${post}/replies`,async route=>{replied=true;replyBody=route.request().postDataJSON();await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({id:'55555555-5555-4555-8555-555555555555',body:'See you there'})});});
  await page.route(`**/api/v1/forums/posts/${post}/report`,async route=>{reported=true;reportBody=route.request().postDataJSON();await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({id:'66666666-6666-4666-8666-666666666666',state:'open'})});});
  await page.route('**/api/v1/blocks',async route=>{blocked=true;blockBody=route.request().postDataJSON();posts=[];await route.fulfill({status:201,contentType:'application/json',body:'{}'});});
  await page.goto(`${webUrl}/groups`);
  await expect(page.locator('[data-groups-page]')).not.toHaveAttribute('data-groups-locale-pending', '');
  await expect(page.locator('[data-catalog-key="groups.title"]')).toHaveAttribute('data-catalog-render-state', 'english_source');
  await expect(page.locator('[data-catalog-affordance-group]')).toHaveCount(0);
  const surface = page.locator('[data-groups-page]');
  await expect(page.getByText('Anyone for a morning walk?')).toBeVisible();
  await page.getByLabel('Message').fill('<strong>Bring water</strong>');await page.getByRole('button',{name:'Post to group'}).click();await expect(surface.getByRole('status')).toContainText('post is visible');await expect(page.getByText('<strong>Bring water</strong>')).toBeVisible();await expect(surface.locator('strong',{hasText:'Bring water'})).toHaveCount(0);
  await page.getByLabel('Message').fill('Second post too quickly');await page.getByRole('button',{name:'Post to group'}).click();await expect(surface.getByRole('status')).toContainText('wait a moment');await expect(page.getByLabel('Message')).toHaveValue('Second post too quickly');
  await page.getByLabel('Reply').first().fill('See you there');await page.getByRole('button',{name:'Post reply'}).first().click();await expect(surface.getByRole('status')).toContainText('reply was posted');await page.getByRole('button',{name:'Report'}).first().click();await expect(surface.getByRole('status')).toContainText('human moderation queue');await page.getByRole('button',{name:'Block person'}).first().click();await expect(surface.getByRole('status')).toContainText('content are now hidden');
  expect({publishedBodies,replyBody,reportBody,blockBody,replied,reported,blocked}).toEqual({publishedBodies:['<strong>Bring water</strong>','Second post too quickly'],replyBody:{body:'See you there'},reportBody:{reason:'community_safety'},blockBody:{user_id:author},replied:true,reported:true,blocked:true});
});

test('Spanish shell holds critical group copy and deduplicates governed fallback notices @smoke', async ({ page }) => {
  const webUrl = process.env.WP015_WEB_URL ?? 'http://localhost:3110';
  const topic = '11111111-1111-4111-8111-111111111111';
  const author = '22222222-2222-4222-8222-222222222222';
  const post = '33333333-3333-4333-8333-333333333333';
  await page.context().addCookies([{ name: 'seniorsocial.locale.v1', value: 'es', url: webUrl }]);
  await page.route('**/api/v1/forums/topics', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ items: [{ id: topic, title: 'Vecinos', post_count: 1 }], meta: { next_cursor: null, total_known: true } }),
  }));
  await page.route(`**/api/v1/forums/topics/${topic}/posts`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      items: [{ id: post, author_id: author, body: 'Contenido dinámico sin traducir', flag_state: 'flagged_awaiting_human' }],
      meta: { next_cursor: null, total_known: true },
    }),
  }));
  await page.route(`**/api/v1/forums/posts/${post}/report`, route => route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/v1/blocks', route => route.fulfill({ status: 201, contentType: 'application/json', body: '{}' }));

  await page.goto(`${webUrl}/groups`);
  const surface = page.locator('[data-groups-page]');
  await expect(surface).not.toHaveAttribute('data-groups-locale-pending', '');
  await expect(page.locator('[data-catalog-key="groups.title"]')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-catalog-key="groups.title"]')).toHaveAttribute('data-catalog-render-state', 'provisional_english_fallback');
  await expect(page.locator('[data-catalog-key="groups.safety_notice"]')).toHaveAttribute('lang', 'en');
  await expect(page.locator('[data-catalog-key="groups.safety_notice"]')).toHaveAttribute('data-catalog-render-state', 'metadata_error_english_fallback');
  await expect(page.getByText('The City will never ask you for payment, gift cards, or a verification code in a group.')).toBeVisible();
  await expect(page.getByText('La Ciudad nunca le pedirá un pago', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Vecinos (1)')).toBeVisible();
  await expect(page.getByText('Contenido dinámico sin traducir')).toBeVisible();
  await expect(page.getByText('Awaiting human safety review; still visible.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Block person' })).toBeVisible();
  for (const heldSpanish of [
    'La Ciudad nunca le pedirá un pago', 'En espera de revisión humana de seguridad', 'Reportar', 'Bloquear persona',
  ]) await expect(page.getByText(heldSpanish, { exact: false })).toHaveCount(0);

  const provisional = surface.locator('[data-catalog-affordance="provisional_english_fallback"]');
  const held = surface.locator('[data-catalog-affordance="metadata_error_english_fallback"]');
  await expect(provisional).toHaveCount(1);
  await expect(provisional).toHaveText('Spanish translation is awaiting review.');
  await expect(held).toHaveCount(1);
  await expect(held).toHaveText('available in English only');
  const provisionalId = await provisional.getAttribute('id') ?? '';
  const heldId = await held.getAttribute('id') ?? '';
  for (const ordinaryFallback of [
    page.locator('[data-catalog-key="groups.title"]'), surface.getByRole('status').locator('[data-catalog-key]'), page.getByLabel('Reply'),
    page.getByRole('button', { name: 'Post reply' }), page.getByLabel('Message'),
    page.getByRole('button', { name: 'Post to group' }), page.getByRole('link', { name: 'Call a person' }),
  ]) await expect(ordinaryFallback).toHaveAttribute('aria-describedby', provisionalId);
  for (const criticalFallback of [
    page.locator('[data-catalog-key="groups.safety_notice"]'), page.locator('[data-catalog-key="groups.awaiting_review"]'),
    page.getByRole('button', { name: 'Report' }), page.getByRole('button', { name: 'Block person' }),
  ]) await expect(criticalFallback).toHaveAttribute('aria-describedby', heldId);
  const topicNavigation = page.getByRole('navigation', { name: 'Group topics' });
  await expect(topicNavigation).toHaveAttribute('lang', 'en');
  await expect(topicNavigation).toHaveAttribute('data-catalog-render-state', 'provisional_english_fallback');
  await expect(topicNavigation).toHaveAttribute('aria-describedby', provisionalId);
  await page.getByRole('button', { name: 'Report' }).click();
  await expect(surface.getByRole('status')).toContainText('Report sent directly to the human moderation queue.');
  await expect(surface.getByRole('status').locator('[data-catalog-key]')).toHaveAttribute('aria-describedby', heldId);
  await expect(page.getByText('El reporte se envió directamente', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Block person' }).click();
  await expect(surface.getByRole('status')).toContainText('This person and their content are now hidden from you.');
  await expect(surface.getByRole('status').locator('[data-catalog-key]')).toHaveAttribute('aria-describedby', heldId);
  await expect(page.getByText('Esta persona y su contenido', { exact: false })).toHaveCount(0);
});
