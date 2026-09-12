import {expect,test} from '@playwright/test';
import {createDatabaseClient} from '../../../packages/db/src/index';
import {E2E_ORG_ID,E2E_RESIDENT_TOKEN,E2E_REVIEWER_TOKEN,E2E_STAFF_TOKEN,wp021E2eEnvironment} from './environment';

const sessionCookie=(value:string)=>({name:'ss_session',value,url:'http://localhost:3121'});
const localeCookie={name:'seniorsocial.locale.v1',value:'es',url:'http://localhost:3121'};

test('WP-021 production runtime gates anonymous and resident access without disclosure',async({context,page})=>{
  // what_bug_this_catches: protecting only mutations while rendering the administrative workbench to non-staff visitors.
  let response=await page.goto('/translate'); expect(response?.status()).toBe(404); expect((await context.request.get('/api/v1/admin/translations')).status()).toBe(404);
  await context.addCookies([sessionCookie(E2E_RESIDENT_TOKEN),localeCookie]); response=await page.goto('/translate'); expect(response?.status()).toBe(404);
  const api=await context.request.post('/api/v1/admin/translations',{data:{action:'source',key:'forbidden',text:'Forbidden',critical:false}}); expect(api.status()).toBe(404); expect(await api.json()).toMatchObject({code:'not_found'});
  await expect(page.getByRole('heading',{name:'Revisión de la traducción al español'})).toHaveCount(0);
});

test('WP-021 production UI executes the real session, route, RLS, workflow, and PostgreSQL journey',async({context,page})=>{
  // what_bug_this_catches: a mocked browser demo passing while production auth, canonical approval, SQL invalidation, or current rendering is broken.
  await context.addCookies([sessionCookie(E2E_STAFF_TOKEN),localeCookie]);
  await Promise.all([page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/v1/admin/translations'),page.goto('/translate')]);
  await expect(page.getByRole('heading',{name:'Revisión de la traducción al español'})).toBeVisible();
  await page.getByLabel('Clave del texto original').fill('e2e.notice'); await page.getByLabel('Texto original en inglés').fill('Call the office on September 18, 2026.'); await page.getByLabel('Contenido crítico').check(); await page.getByRole('button',{name:'Crear o actualizar el texto original'}).click(); await expect(page.getByRole('heading',{name:'e2e.notice'})).toBeVisible();
  const aiResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/api/v1/admin/translations'&&response.status()===503); await page.getByRole('button',{name:'Borrador con asistencia automática'}).click(); await aiResponse; await expect(page.getByRole('status')).toContainText('La redacción automática está desactivada');
  await page.getByLabel('Texto del borrador en español').fill('Llame a la oficina el 18 de septiembre de 2026.'); await page.getByRole('button',{name:'Borrador manual'}).click(); await expect(page.getByText('Borrador',{exact:true})).toBeVisible();

  await context.addCookies([sessionCookie(E2E_REVIEWER_TOKEN),localeCookie]); await Promise.all([page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/v1/admin/translations'),page.reload()]);
  await page.getByLabel('Nota de revisión').fill('Revisión sintética cualificada'); const approve=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/approve')&&response.status()===200); await page.getByRole('button',{name:'Aprobar'}).click(); await approve; await expect(page.getByText('Aprobado',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Publicar'}).click(); await expect(page.getByText('No se puede',{exact:true})).toBeVisible();
  await page.getByLabel('Clave del texto original').fill('e2e.notice'); await page.getByLabel('Texto original en inglés').fill('Call the new office on September 18, 2026.'); await page.getByRole('button',{name:'Crear o actualizar el texto original'}).click(); await expect(page.getByText('Invalidado',{exact:true})).toBeVisible(); await expect(page.getByText(/Versión de origen: 2/u)).toBeVisible();

  const owner=createDatabaseClient(wp021E2eEnvironment().databaseUrl); try { expect(await owner`SELECT draft_id FROM current_published_translations WHERE org_id=${E2E_ORG_ID} AND resource_key='e2e.notice'`).toHaveLength(0); expect(await owner`SELECT id FROM audit_events WHERE org_id=${E2E_ORG_ID} AND action='translation.invalidated'`).toHaveLength(1); } finally { await owner.end(); }
});
