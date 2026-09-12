import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withOrg as withDatabaseOrg, type DatabaseClient, type TenantTransaction } from '../../../packages/db/src/index.ts';
import { createRagRepository, type RagOrgTransaction } from '../../../packages/rag/src/index.ts';

const suppliedDatabaseUrl = process.env.DATABASE_URL;
const dedicatedDatabase = (() => {
  try { return suppliedDatabaseUrl !== undefined && new URL(suppliedDatabaseUrl).pathname === '/seniorsocial_wp023_test'; }
  catch { return false; }
})();
const databaseUrl = dedicatedDatabase ? suppliedDatabaseUrl as string : 'postgres://invalid:invalid@127.0.0.1:1/not_wp023';
const postgresSuite = dedicatedDatabase ? describe : describe.skip;
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db');
const migrationRoot = join(packageRoot, 'migrations');
const owner = createDatabaseClient(databaseUrl);
const runtimeRole = 'seniorsocial_wp023_test_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole; runtimeUrl.password = runtimePassword;
let runtime: DatabaseClient;
let rolledBack = false;

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const userA = '11111111-1111-4111-8111-111111111101';
const userB = '22222222-2222-4222-8222-222222222201';
const categoryA = '11111111-1111-4111-8111-111111111121';
const categoryB = '22222222-2222-4222-8222-222222222221';
const meal = '11111111-1111-4111-8111-111111111151';
const ride = '11111111-1111-4111-8111-111111111152';
const poison = '22222222-2222-4222-8222-222222222251';

function migration(direction: 'up' | 'down') {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot, env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' }, stdio: 'pipe',
  });
}
function seed() {
  execFileSync(process.execPath, ['--import', 'tsx', 'seed/run.ts'], {
    cwd: packageRoot, env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' }, stdio: 'pipe',
  });
}

async function exactMigration(direction: 'up' | 'down') {
  const name = direction === 'up' ? '0170_wp-023_rag.sql' : '0170_wp-023_rag.down.sql';
  await owner.unsafe(readFileSync(join(migrationRoot, name), 'utf8'));
}

postgresSuite('WP-023 live pgvector retrieval', () => {
  beforeAll(async () => {
    migration('down'); migration('up');
    await exactMigration('down');
    const absent = await owner<{ name: string | null }[]>`select to_regclass('public.service_embeddings')::text as name`;
    rolledBack = absent[0]?.name === null;
    await exactMigration('up'); await exactMigration('down'); await exactMigration('up'); seed();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' IN ROLE seniorsocial_app`);
    runtime = createDatabaseClient(runtimeUrl.toString());
    await owner`insert into services (id,org_id,category_id,name_en,name_es,description_en,description_es,
      source_updated_at,publication_state,reviewed_by,reviewed_at) values
      (${meal},${orgA},${categoryA},'Meal delivery','Entrega de comidas','Hot meals delivered','Comidas calientes',now(),'published',${userA},now()),
      (${ride},${orgA},${categoryA},'Accessible rides','Viajes accesibles','Wheelchair transportation','Transporte',now(),'published',${userA},now()),
      (${poison},${orgB},${categoryB},'Secret exact meal','Comida secreta','Poisoned cross tenant vector','Vector envenenado',now(),'published',${userB},now())`;
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.end();
  });

  const withOrg: RagOrgTransaction = (orgId, work) => withDatabaseOrg(runtime, orgId, (transaction: TenantTransaction) => work({
    query: <T>(text: string, values: readonly (string | number | null)[]) => transaction.unsafe<T[]>(text, [...values]),
  }));

  // what_bug_this_catches: 0170 cannot roll back and replay, or pgvector is not actually installed.
  it('migrates up/down/up and enables pgvector safely', async () => {
    expect(rolledBack).toBe(true);
    const extension = await owner<{ version: string }[]>`select extversion as version from pg_extension where extname='vector'`;
    expect(extension[0]?.version).toMatch(/^0\./u);
    const defaults = await owner<{ scope: string; enabled: boolean }[]>`
      select scope::text, enabled from feature_flags where flag_key='rag.enabled' order by scope`;
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    expect(defaults.every(row => row.enabled === false)).toBe(true);
  });

  // what_bug_this_catches: hybrid retrieval ignores FTS, semantic rank, freshness, or deterministic score bounds.
  it('combines FTS and semantic ranks and excludes stale embeddings', async () => {
    const repository = createRagRepository(withOrg);
    expect((await repository.hybrid(orgA, 'meal', 'en', [1, 0], 2, 5))[0]?.service_id).toBe(meal);
    for (const [serviceId, key, vector] of [[meal, 'meal-v1', [1, 0]], [ride, 'ride-v1', [0, 1]]] as const) {
      const prepared = await repository.prepare(orgA, serviceId, key);
      expect(prepared).not.toBeNull();
      await expect(repository.replace({ orgId: orgA, serviceId, idempotencyKey: key,
        contentVersion: prepared?.contentVersion ?? '', contentFingerprint: prepared?.contentFingerprint ?? '',
        embedding: vector, dimensions: 2, model: 'test-stub' })).resolves.toBe('indexed');
    }
    const ranked = await repository.hybrid(orgA, 'meal', 'en', [1, 0], 2, 5);
    expect(ranked[0]?.service_id).toBe(meal);
    expect(ranked.every(hit => Number.isFinite(hit.score) && hit.score >= 0 && hit.score <= 1)).toBe(true);

    const before = await repository.prepare(orgA, meal, 'meal-v2');
    await owner`update services set name_en='Nutrition delivery', description_en='' where org_id=${orgA} and id=${meal}`;
    await expect(repository.replace({ orgId: orgA, serviceId: meal, idempotencyKey: 'meal-v2',
      contentVersion: before?.contentVersion ?? '', contentFingerprint: before?.contentFingerprint ?? '',
      embedding: [1, 0], dimensions: 2, model: 'test-stub' })).resolves.toBe('stale');
    expect((await repository.hybrid(orgA, 'meal', 'en', [1, 0], 2, 5)).map(hit => hit.service_id)).not.toContain(meal);
  });

  // what_bug_this_catches: a repeated rag.reindex key writes or bills twice instead of resolving as the same operation.
  it('recognizes an idempotent reindex key for the current service version', async () => {
    const repository = createRagRepository(withOrg);
    const prepared = await repository.prepare(orgA, ride, 'ride-v1');
    expect(prepared?.alreadyProcessed).toBe(true);
    await expect(repository.replace({ orgId: orgA, serviceId: ride, idempotencyKey: 'ride-v1',
      contentVersion: prepared?.contentVersion ?? '', contentFingerprint: prepared?.contentFingerprint ?? '',
      embedding: [0, 1], dimensions: 2, model: 'test-stub' })).resolves.toBe('duplicate');
  });

  // what_bug_this_catches: RLS or a missing explicit org predicate lets a poisoned cross-tenant vector win retrieval.
  it('enforces RLS and discloses nothing from a poisoned cross-org vector', async () => {
    const repository = createRagRepository(withOrg);
    const prepared = await repository.prepare(orgB, poison, 'poison-v1');
    await repository.replace({ orgId: orgB, serviceId: poison, idempotencyKey: 'poison-v1',
      contentVersion: prepared?.contentVersion ?? '', contentFingerprint: prepared?.contentFingerprint ?? '',
      embedding: [1, 0], dimensions: 2, model: 'test-stub' });
    const visible = await withDatabaseOrg(runtime, orgA, transaction => transaction<{ service_id: string }[]>`
      select service_id from service_embeddings order by service_id`);
    expect(visible.map(row => row.service_id)).not.toContain(poison);
    expect((await repository.hybrid(orgA, 'secret meal', 'en', [1, 0], 2, 10)).map(hit => hit.service_id)).not.toContain(poison);
    await owner`delete from service_embeddings where org_id=${orgB} and service_id=${poison}`;
    const foreignTarget = await owner<{ exists: boolean }[]>`
      select exists(select 1 from services where org_id=${orgB} and id=${poison}) as exists`;
    expect(foreignTarget[0]?.exists).toBe(true);
    let errorCode = '';
    try {
      await withDatabaseOrg(runtime, orgA, transaction => transaction`
        insert into service_embeddings (org_id,service_id,content_version,content_fingerprint,embedding,dimensions,
          embedding_model,idempotency_key,reindex_actor) values (${orgB},${poison},'2026-09-10T12:00:00.000000Z',
          ${'f'.repeat(32)},${'[1,0]'}::vector,2,'bad','bad','system:rag-reindex')`);
    } catch (error) { errorCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''; }
    expect(errorCode).toBe('42501');
  });
});
