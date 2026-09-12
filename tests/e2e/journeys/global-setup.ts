import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabaseClient } from '../../../packages/db/src/index.ts';
import { digestSecret } from '../../../packages/auth/src/index.ts';
import {
  ADMIN_ID, ADMIN_TOKEN,
  FOREIGN_ORG_ID, FOREIGN_RESIDENT_ID, FOREIGN_RESIDENT_TOKEN, FOREIGN_STAFF_ID,
  ORG_ID, OTHER_RESIDENT_ID, PEPPER, RESIDENT_ID, RESIDENT_TOKEN, STAFF_ID, STAFF_TOKEN,
  caregiverId, caregiverToken, eventId, journeyEnvironment, linkId, matrix,
} from './environment.ts';

const migrations = [
  '0001_wp-003_core_tables.sql', '0010_wp-004_auth.sql', '0011_wp-004_auth_rate_limits.sql',
  '0020_wp-005_consent_policy.sql', '0030_wp-006_audit_flags.sql', '0031_wp-006_audit_fields.sql',
  '0032_wp-006_notification_audit_actions.sql', '0040_wp-009_notify.sql', '0041_wp-009_completion.sql',
  '0050_wp-010_services.sql', '0060_wp-012_events.sql', '0071_wp-013_ride_requests.sql',
  '0072_wp-013_ride_transitions.sql', '0080_wp-014_assistance.sql', '0110_wp-017_caregiver_invitations.sql',
  '0190_wp-011_concierge_conversations.sql',
] as const;

async function phase<T>(owner: string, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new Error(`[${owner}] ${name} failed`, { cause: error }); }
}

function futureEventId(index: number): string {
  return `53000000-0000-4000-8700-${String(100 + index).padStart(12, '0')}`;
}

export default async function globalSetup() {
  const environment = journeyEnvironment();
  const admin = createDatabaseClient(environment.ownerUrl);
  let owner: ReturnType<typeof createDatabaseClient> | undefined;
  let databaseCreated = false;
  let roleCreated = false;
  let sharedRolePreexisting = true;
  const cleanup = async () => {
    const errors: unknown[] = [];
    try { if (owner) await owner.end(); } catch (error) { errors.push(error); }
    try { if (databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${environment.databaseName}" WITH (FORCE)`); } catch (error) { errors.push(error); }
    try { if (roleCreated) await admin.unsafe(`DROP ROLE IF EXISTS "${environment.runtimeRole}"`); } catch (error) { errors.push(error); }
    try {
      if (!sharedRolePreexisting) await admin.unsafe('DROP ROLE IF EXISTS seniorsocial_app');
    } catch (error) { errors.push(error); }
    try { await admin.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, '[WP-030 fixture cleanup] failed to remove only run-owned database/roles');
  };
  try {
    const existing = await phase('WP-030 fixture', 'inspect cluster-global database/role ownership', async () =>
      (await admin<{ database_exists: boolean; role_exists: boolean; shared_role_exists: boolean }[]>`
        SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${environment.databaseName}) AS database_exists,
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${environment.runtimeRole}) AS role_exists,
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname='seniorsocial_app') AS shared_role_exists`)[0]);
    if (existing?.database_exists || existing?.role_exists) throw new Error('WP-030 isolated database or runtime role already exists; choose a fresh run ID');
    sharedRolePreexisting = existing?.shared_role_exists ?? false;
    await phase('WP-003 database', 'create isolated journey database', () => admin.unsafe(`CREATE DATABASE "${environment.databaseName}"`)); databaseCreated = true;
    owner = createDatabaseClient(environment.databaseUrl);
    for (const name of migrations) {
      const packageName = name.match(/wp-\d+/u)?.[0]?.toUpperCase() ?? 'DB';
      await phase(`${packageName} migration`, name, async () => owner!.unsafe(await readFile(resolve(process.cwd(), 'packages/db/migrations', name), 'utf8')));
    }
    await phase('WP-003 database', 'create constrained journey runtime role', () => admin.unsafe(`CREATE ROLE "${environment.runtimeRole}" LOGIN PASSWORD '${environment.runtimePassword}' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`));
    roleCreated = true;
    await phase('WP-003 database', 'grant application role to constrained runtime', () => admin.unsafe(`GRANT seniorsocial_app TO "${environment.runtimeRole}"`));
    await phase('WP-003 identity fixture', 'seed two isolated synthetic tenants', async () => {
      await owner!`INSERT INTO orgs(id,name,slug,locale_default) VALUES
        (${ORG_ID},'WP-030 synthetic journeys','wp030-e2e','en'),
        (${FOREIGN_ORG_ID},'WP-030 foreign tenant','wp030-foreign','es')`;
      await owner!`INSERT INTO users(id,org_id,display_name,email,account_state,locale,is_demo) VALUES
      (${RESIDENT_ID},${ORG_ID},'Synthetic resident','resident@example.invalid','active','en',true),
      (${STAFF_ID},${ORG_ID},'Synthetic staff','staff@example.invalid','active','en',true),
      (${OTHER_RESIDENT_ID},${ORG_ID},'Synthetic capacity holder','holder@example.invalid','active','en',true),
      (${ADMIN_ID},${ORG_ID},'Synthetic admin','admin@example.invalid','active','en',true),
      (${FOREIGN_RESIDENT_ID},${FOREIGN_ORG_ID},'Foreign synthetic resident','foreign-resident@example.invalid','active','es',true),
      (${FOREIGN_STAFF_ID},${FOREIGN_ORG_ID},'Foreign synthetic staff','foreign-staff@example.invalid','active','es',true)`;
      await owner!`INSERT INTO user_roles(org_id,user_id,role) VALUES
        (${ORG_ID},${RESIDENT_ID},'senior'),(${ORG_ID},${STAFF_ID},'staff'),(${ORG_ID},${OTHER_RESIDENT_ID},'senior'),
        (${ORG_ID},${ADMIN_ID},'admin'),
        (${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},'senior'),(${FOREIGN_ORG_ID},${FOREIGN_STAFF_ID},'staff')`;
      await owner!`INSERT INTO profiles(org_id,user_id,preferred_name,accessibility_conditions) VALUES
      (${ORG_ID},${RESIDENT_ID},'Synthetic resident',${['step-free']}),
      (${ORG_ID},${OTHER_RESIDENT_ID},'Capacity holder',${[] as string[]}),
      (${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},'Foreign resident',${['wheelchair']})`;
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await phase('WP-004 auth fixture', 'seed tenant-bound sessions', async () => owner!`INSERT INTO sessions(org_id,user_id,token_digest,expires_at,is_demo) VALUES
      (${ORG_ID},${RESIDENT_ID},${digestSecret(RESIDENT_TOKEN,PEPPER)},${expiresAt},true),
      (${ORG_ID},${STAFF_ID},${digestSecret(STAFF_TOKEN,PEPPER)},${expiresAt},true),
      (${ORG_ID},${ADMIN_ID},${digestSecret(ADMIN_TOKEN,PEPPER)},${expiresAt},true),
      (${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},${digestSecret(FOREIGN_RESIDENT_TOKEN,PEPPER)},${expiresAt},true)`);
    const categoryId = '53000000-0000-4000-8400-000000000030';
    const serviceId = '53000000-0000-4000-8500-000000000030';
    const foreignCategoryId = '53000000-0000-4000-9400-000000000030';
    await phase('WP-010 services fixture', 'seed tenant-local and foreign directory records', async () => {
      await owner!`INSERT INTO service_categories(id,org_id,slug,label_en,label_es) VALUES
        (${categoryId},${ORG_ID},'food','Food','Comida'),(${foreignCategoryId},${FOREIGN_ORG_ID},'private','Private','Privado')`;
      await owner!`INSERT INTO services(id,org_id,external_id,category_id,name_en,name_es,description_en,description_es,
      eligibility_note_en,eligibility_note_es,phone,source_updated_at,publication_state,reviewed_by,reviewed_at)
      VALUES (${serviceId},${ORG_ID},'meal-wp030',${categoryId},'Home-delivered meals','Comidas a domicilio',
      'Fresh meals delivered at home','Comidas frescas entregadas a domicilio','Call to confirm eligibility','Llame para confirmar elegibilidad',
      '555-0130','2026-09-10T12:00:00Z','published',${STAFF_ID},'2026-09-10T12:00:00Z'),
      ('53000000-0000-4000-9500-000000000030',${FOREIGN_ORG_ID},'foreign-secret',${foreignCategoryId},'Foreign tenant secret','Secreto de otro inquilino',
      'Must never cross tenant boundary','Nunca debe cruzar el límite','','','','2026-09-10T12:00:00Z','published',${FOREIGN_STAFF_ID},'2026-09-10T12:00:00Z')`;
    });
    for (const [index, variant] of matrix.entries()) {
      const variantCaregiverId = caregiverId(index);
      await phase('WP-017 caregiver fixture', `seed caregiver/link for ${variant.locale}/${variant.mode}`, async () => {
      await owner!`INSERT INTO users(id,org_id,display_name,email,account_state,locale,is_demo)
        VALUES(${variantCaregiverId},${ORG_ID},${`Synthetic caregiver ${index}`},${`caregiver-${index}@example.invalid`},'active','en',true)`;
      await owner!`INSERT INTO user_roles(org_id,user_id,role) VALUES(${ORG_ID},${variantCaregiverId},'caregiver')`;
      await owner!`INSERT INTO sessions(org_id,user_id,token_digest,expires_at,is_demo)
        VALUES(${ORG_ID},${variantCaregiverId},${digestSecret(caregiverToken(index),PEPPER)},${expiresAt},true)`;
      await owner!`INSERT INTO caregiver_links(id,org_id,resident_id,caregiver_id,state) VALUES(${linkId(index)},${ORG_ID},${RESIDENT_ID},${variantCaregiverId},'pending')`;
      });
      const suffix = `${variant.locale}-${variant.mode}`;
      const openId = eventId(index, false); const fullId = eventId(index, true); const futureId = futureEventId(index);
      await phase('WP-012 events fixture', `seed RSVP/waitlist events for ${suffix}`, async () => {
      await owner!`INSERT INTO events(id,org_id,title,starts_at,time_zone,location,capacity,accessibility,published_at,created_by) VALUES
        (${openId},${ORG_ID},${variant.locale === 'es' ? `Evento abierto ${suffix}` : `Open event ${suffix}`},statement_timestamp() + interval '12 hours','America/New_York',${variant.locale === 'es' ? 'Salón comunitario' : 'Community hall'},4,${['step-free']},now(),${STAFF_ID}),
        (${fullId},${ORG_ID},${variant.locale === 'es' ? `Evento completo ${suffix}` : `Full event ${suffix}`},statement_timestamp() + interval '36 hours','America/New_York',${variant.locale === 'es' ? 'Sala de la biblioteca' : 'Library room'},1,${['step-free']},now(),${STAFF_ID}),
        (${futureId},${ORG_ID},${variant.locale === 'es' ? `Evento futuro ${suffix}` : `Future event ${suffix}`},statement_timestamp() + interval '72 hours','America/New_York',${variant.locale === 'es' ? 'Centro comunitario' : 'Community center'},4,${['step-free']},now(),${STAFF_ID})`;
      await owner!`INSERT INTO event_rsvps(org_id,event_id,user_id,state) VALUES(${ORG_ID},${fullId},${OTHER_RESIDENT_ID},'attending')`;
      });
    }
    await phase('WP-010/WP-012/WP-013/WP-014/WP-017 cross-tenant fixtures', 'seed foreign service, event, ride, assistance and caregiver rows', async () => {
      const foreignEvent = '53000000-0000-4000-9200-000000000030';
      const foreignRide = '53000000-0000-4000-9700-000000000030';
      const foreignAssistance = '53000000-0000-4000-9800-000000000030';
      await owner!`INSERT INTO events(id,org_id,title,starts_at,time_zone,location,capacity,published_at,created_by)
        VALUES(${foreignEvent},${FOREIGN_ORG_ID},'Foreign tenant event','2027-01-17T18:00:00Z','America/New_York','Private room',4,now(),${FOREIGN_STAFF_ID})`;
      await owner!`INSERT INTO ride_requests(id,org_id,resident_id,requested_by_actor_id,purpose,mode,pickup_at,pickup_tz,pickup_location,destination_location,return_needed,idempotency_key,request_hash,send_state,dispatch_reference)
        VALUES(${foreignRide},${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},${FOREIGN_RESIDENT_ID},'private foreign ride','partner_van','2027-01-20T13:30:00Z','America/New_York','private','private',false,'foreign-ride-key',${'f'.repeat(64)},'sent','foreign-local-queue')`;
      await owner!`INSERT INTO ride_transitions(org_id,ride_id,actor_id,from_state,to_state,reason,idempotency_key,request_hash)
        VALUES(${FOREIGN_ORG_ID},${foreignRide},${FOREIGN_RESIDENT_ID},'requested','waiting_for_dispatcher','foreign fixture','foreign-transition',${'f'.repeat(64)})`;
      await owner!`INSERT INTO assistance_requests(id,org_id,requester_id,summary_ciphertext,locale,triage_category,triage_source,after_hours,idempotency_key)
        VALUES(${foreignAssistance},${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},'opaque-foreign-ciphertext','es','general','rules',false,'foreign-assistance-key')`;
      await owner!`INSERT INTO assistance_transitions(org_id,request_id,actor_id,from_state,to_state,owner_id,reason)
        VALUES(${FOREIGN_ORG_ID},${foreignAssistance},${FOREIGN_RESIDENT_ID},null,'pending_unowned',null,'foreign fixture')`;
      await owner!`INSERT INTO sla_clocks(org_id,request_id,due_at)
        SELECT org_id,id,created_at + interval '240 minutes' FROM assistance_requests WHERE org_id=${FOREIGN_ORG_ID} AND id=${foreignAssistance}`;
      await owner!`INSERT INTO caregiver_links(id,org_id,resident_id,caregiver_id,state)
        VALUES('53000000-0000-4000-9300-000000000030',${FOREIGN_ORG_ID},${FOREIGN_RESIDENT_ID},${FOREIGN_STAFF_ID},'pending')`;
    });
    await owner.end(); owner = undefined;
    return cleanup;
  } catch (error) {
    try { await cleanup(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '[WP-030 fixture] setup failed and run-owned cleanup also failed', { cause: cleanupError });
    }
    throw error;
  }
}
