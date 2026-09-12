import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createDatabaseClient} from '../../../packages/db/src/index';
import {digestSecret} from '../../../packages/auth/src/index';
import {E2E_ORG_ID,E2E_PEPPER,E2E_RESIDENT_ID,E2E_RESIDENT_TOKEN,E2E_REVIEWER_ID,E2E_REVIEWER_TOKEN,E2E_STAFF_ID,E2E_STAFF_TOKEN,wp021E2eEnvironment} from './environment';

export default async function globalSetup() {
  const environment=wp021E2eEnvironment(); const admin=createDatabaseClient(environment.ownerUrl); let owner:ReturnType<typeof createDatabaseClient>|undefined; let databaseCreated=false; let roleCreated=false;
  const cleanup=async()=>{ if(owner) await owner.end(); if(databaseCreated) await admin.unsafe(`DROP DATABASE IF EXISTS "${environment.databaseName}" WITH (FORCE)`); if(roleCreated) await admin.unsafe(`DROP ROLE IF EXISTS "${environment.runtimeRole}"`); await admin.end(); };
  try {
    const existing=(await admin<{database_exists:boolean;role_exists:boolean}[]>`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${environment.databaseName}) AS database_exists,EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${environment.runtimeRole}) AS role_exists`)[0];
    if(existing?.database_exists || existing?.role_exists) throw new Error('WP-021 E2E isolated database or runtime role already exists; use a fresh run ID');
    await admin.unsafe(`CREATE DATABASE "${environment.databaseName}"`); databaseCreated=true; owner=createDatabaseClient(environment.databaseUrl);
    for(const name of ['0001_wp-003_core_tables.sql','0010_wp-004_auth.sql','0011_wp-004_auth_rate_limits.sql','0030_wp-006_audit_flags.sql','0031_wp-006_audit_fields.sql','0150_wp-021_translations.sql']) await owner.unsafe(await readFile(resolve(process.cwd(),'packages/db/migrations',name),'utf8'));
    await admin.unsafe(`CREATE ROLE "${environment.runtimeRole}" LOGIN PASSWORD '${environment.runtimePassword}' INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`); roleCreated=true;
    await admin.unsafe(`GRANT seniorsocial_app TO "${environment.runtimeRole}"`);
    await owner`INSERT INTO orgs(id,name,slug,locale_default) VALUES(${E2E_ORG_ID},'WP-021 E2E','wp021-e2e','es')`;
    await owner`INSERT INTO users(id,org_id,display_name,account_state,locale) VALUES
      (${E2E_STAFF_ID},${E2E_ORG_ID},'Synthetic staff','active','es'),
      (${E2E_REVIEWER_ID},${E2E_ORG_ID},'Synthetic reviewer','active','es'),
      (${E2E_RESIDENT_ID},${E2E_ORG_ID},'Synthetic resident','active','es')`;
    await owner`INSERT INTO user_roles(org_id,user_id,role) VALUES
      (${E2E_ORG_ID},${E2E_STAFF_ID},'staff'),(${E2E_ORG_ID},${E2E_REVIEWER_ID},'admin'),(${E2E_ORG_ID},${E2E_RESIDENT_ID},'senior')`;
    const expiresAt=new Date(Date.now()+60*60*1000);
    await owner`INSERT INTO sessions(org_id,user_id,token_digest,expires_at) VALUES
      (${E2E_ORG_ID},${E2E_STAFF_ID},${digestSecret(E2E_STAFF_TOKEN,E2E_PEPPER)},${expiresAt}),
      (${E2E_ORG_ID},${E2E_REVIEWER_ID},${digestSecret(E2E_REVIEWER_TOKEN,E2E_PEPPER)},${expiresAt}),
      (${E2E_ORG_ID},${E2E_RESIDENT_ID},${digestSecret(E2E_RESIDENT_TOKEN,E2E_PEPPER)},${expiresAt})`;
    await owner.begin(async transaction=>{await transaction`SELECT set_config('app.current_org_id',${E2E_ORG_ID},true)`; const rows=await transaction<{granted:boolean}[]>`SELECT wp021_grant_translation_reviewer(${E2E_ORG_ID},${E2E_REVIEWER_ID},'Synthetic qualified Spanish reviewer',${E2E_REVIEWER_ID},'WP-021 browser test grant') AS granted`; if(!rows[0]?.granted) throw new Error('reviewer grant failed');});
    await owner.end(); owner=undefined;
    return cleanup;
  } catch(error) { await cleanup(); throw error; }
}
