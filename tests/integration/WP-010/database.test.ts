import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withOrg } from '../../../packages/db/src/index.ts';
import { appendAudit } from '../../../packages/audit/src/index.ts';
import { createServicesRepository } from '../../../packages/services/src/index.ts';
import type { OrgTransaction } from '../../../packages/services/src/index.ts';

const databaseUrl = process.env.DATABASE_URL;
const dedicated = databaseUrl !== undefined && new URL(databaseUrl).pathname === '/seniorsocial_wp010_test';
const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = '22222222-2222-4222-8222-222222222222';
const actorA = '11111111-1111-4111-8111-111111111101';
const actorB = '22222222-2222-4222-8222-222222222201';
const categoryA = '11111111-1111-4111-8111-111111111141';
const categoryB = '22222222-2222-4222-8222-222222222241';
const runtimeRole = 'seniorsocial_wp010_test_login';
const runtimePassword = 'synthetic-test-only';
let owner: ReturnType<typeof createDatabaseClient>;
let runtime: ReturnType<typeof createDatabaseClient>;

function migrate(direction: 'up' | 'down'): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: join(process.cwd(), 'packages', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' }, stdio: 'pipe',
  });
}

const suite = dedicated ? describe : describe.skip;
suite('WP-010 disposable PostgreSQL behavior', () => {
  beforeAll(async () => {
    migrate('down');
    migrate('up');
    owner = createDatabaseClient(databaseUrl);
    await owner.unsafe(`
      insert into orgs (id,name,slug) values
        ('${orgA}','Synthetic North','synthetic-north'), ('${orgB}','Synthetic South','synthetic-south');
      insert into users (id,org_id,display_name) values
        ('${actorA}','${orgA}','Synthetic Operator A'), ('${actorB}','${orgB}','Synthetic Operator B');
      insert into service_categories (id,org_id,slug,label_en,label_es) values
        ('${categoryA}','${orgA}','food','Food','Comida'), ('${categoryB}','${orgB}','food','Food','Comida');
      drop role if exists ${runtimeRole};
      create role ${runtimeRole} login password '${runtimePassword}' in role seniorsocial_app;
    `);
    const runtimeUrl = new URL(databaseUrl ?? '');
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    if (owner) {
      await owner.unsafe(`drop role if exists ${runtimeRole}`);
      await owner.end();
    }
  });

  // what_bug_this_catches: RLS leaks tenants, CSV auto-publishes, Spanish FTS is absent, or an unknown category aborts valid rows.
  it('enforces RLS, ranked bilingual search, partial import rejection, and manual publication', async () => {
    const transaction: OrgTransaction = (orgId, work) => withOrg(runtime, orgId, tx => work({
      query: <T>(text: string, values: readonly (string | number | null)[]) => tx.unsafe<T[]>(text, [...values]),
      audit: intent => appendAudit(tx, intent).then(() => undefined),
    }));
    const repository = createServicesRepository(transaction);
    const direct = await repository.create(orgA, actorA, {
      externalId: 'meal-1', categoryId: categoryA, nameEn: 'Meal delivery', nameEs: 'Entrega de comidas',
      descriptionEn: 'Fresh meals delivered', descriptionEs: 'Comidas frescas entregadas',
      sourceUpdatedAt: '2026-09-10T12:00:00Z', languages: ['en', 'es'], accessibility: ['wheelchair'],
    }, 'en');
    expect(direct).not.toBeNull();
    await repository.create(orgA, actorA, {
      externalId: 'social-1', categoryId: categoryA, nameEn: 'Social club', nameEs: 'Club social',
      descriptionEn: 'Activities that sometimes include meals', descriptionEs: 'Actividades sociales',
      sourceUpdatedAt: '2026-09-10T12:00:00Z',
    }, 'en');
    expect((await repository.search(orgA, { locale: 'en', query: 'meal delivery' })).items[0]?.id).toBe(direct?.id);
    expect(await repository.get(orgB, direct?.id ?? '', 'en')).toBeNull();

    const imported = await repository.importRows(orgA, actorA, [
      { row: 2, input: { externalId: 'meal-1', categoryId: categoryA, nameEn: 'Grocery delivery',
        nameEs: 'Entrega de comestibles', sourceUpdatedAt: '2026-09-11T12:00:00Z', languages: ['es'] } },
      { row: 3, input: { externalId: 'bad-1', categoryId: categoryB, nameEn: 'Wrong category',
        nameEs: 'Categoría incorrecta', sourceUpdatedAt: '2026-09-11T12:00:00Z' } },
    ]);
    expect(imported.imported).toMatchObject([{ row: 2, outcome: 'updated' }]);
    expect(imported.rejected).toMatchObject([{ row: 3, reason: expect.stringContaining('this organisation') }]);
    const createdImport = await repository.importRows(orgA, actorA, [{ row: 2, input: {
      externalId: 'new-draft-1', categoryId: categoryA, nameEn: 'New draft service', nameEs: 'Nuevo servicio borrador',
      sourceUpdatedAt: '2026-09-11T12:00:00Z',
    } }]);
    expect(createdImport.imported).toMatchObject([{ row: 2, outcome: 'created' }]);
    const createdServiceId = createdImport.imported[0]?.id;
    const createdAudit = await owner<{ fields: string[] }[]>`
      select fields from audit_events where target = ${`service:${createdServiceId}`} order by at desc limit 1
    `;
    expect(createdAudit[0]?.fields).toEqual([
      'accessibility', 'category_id', 'description_en', 'description_es', 'eligibility_note_en',
      'eligibility_note_es', 'external_id', 'languages', 'name_en', 'name_es', 'phone',
      'publication_state', 'reviewed_at', 'reviewed_by', 'source_updated_at',
    ]);
    expect(await repository.get(orgA, direct?.id ?? '', 'en')).toBeNull();
    expect((await repository.search(orgA, { locale: 'es', query: 'comestibles' })).items).toEqual([]);

    const approved = await repository.update(orgA, actorA, direct?.id ?? '', { phone: '555-0110' }, 'es');
    expect(approved).toMatchObject({ changedFields: ['phone'], service: { name: 'Entrega de comestibles' } });
    expect((await repository.search(orgA, { locale: 'es', query: 'comestibles' })).items[0]?.id).toBe(direct?.id);
    const crossOrg = await withOrg(runtime, orgA, tx => tx<{ count: number }[]>`
      select count(*)::int as count from services where org_id = ${orgB}
    `);
    expect(crossOrg[0]?.count).toBe(0);
  });

  // what_bug_this_catches: service writes commit even though the mandatory audit insert failed in a separate transaction.
  it('rolls back direct and imported service writes when transactional audit fails', async () => {
    const failingTransaction: OrgTransaction = (orgId, work) => withOrg(runtime, orgId, tx => work({
      query: <T>(text: string, values: readonly (string | number | null)[]) => tx.unsafe<T[]>(text, [...values]),
      audit: async () => { throw new Error('forced audit failure'); },
    }));
    const repository = createServicesRepository(failingTransaction);
    const direct = { externalId: 'rollback-direct', categoryId: categoryA, nameEn: 'Rollback direct',
      nameEs: 'Reversión directa', sourceUpdatedAt: '2026-09-10T12:00:00Z' };
    await expect(repository.create(orgA, actorA, direct, 'en')).rejects.toThrow('forced audit failure');
    const imported = { externalId: 'rollback-import', categoryId: categoryA, nameEn: 'Rollback import',
      nameEs: 'Reversión importada', sourceUpdatedAt: '2026-09-10T12:00:00Z' };
    await expect(repository.importRows(orgA, actorA, [{ row: 2, input: imported }]))
      .rejects.toThrow('forced audit failure');
    const rows = await owner<{ external_id: string }[]>`
      select external_id from services where external_id in ('rollback-direct', 'rollback-import')
    `;
    expect(rows).toEqual([]);
  });
});
