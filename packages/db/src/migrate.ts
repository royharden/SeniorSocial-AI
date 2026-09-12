import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseClient } from './client.ts';

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const migrationPattern = /^\d{4}_wp-\d{3}_[a-z0-9_]+\.sql$/u;

async function migrationNames(): Promise<string[]> {
  return (await readdir(migrationDirectory)).filter(name => migrationPattern.test(name)).sort();
}

async function migrateUp(): Promise<void> {
  const client = createDatabaseClient();
  try {
    const appliedNames: string[] = [];
    await client.begin(async transaction => {
      await transaction`select pg_advisory_xact_lock(hashtext('seniorsocial:migrations'))`;
      await transaction.unsafe(`
        CREATE SCHEMA IF NOT EXISTS seniorsocial_meta;
        CREATE TABLE IF NOT EXISTS seniorsocial_meta.migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
      `);
      for (const name of await migrationNames()) {
        const applied = await transaction<{ exists: boolean }[]>`
          select exists(select 1 from seniorsocial_meta.migrations where name = ${name}) as exists
        `;
        if (applied[0]?.exists) continue;
        const source = await readFile(join(migrationDirectory, name), 'utf8');
        await transaction.unsafe(source);
        await transaction`insert into seniorsocial_meta.migrations (name) values (${name})`;
        appliedNames.push(name);
      }
    });
    for (const name of appliedNames) console.log(`Applied ${name}`);
  } finally {
    await client.end();
  }
}

async function migrateDown(): Promise<void> {
  const client = createDatabaseClient();
  try {
    const revertedNames: string[] = [];
    await client.begin(async transaction => {
      await transaction`select pg_advisory_xact_lock(hashtext('seniorsocial:migrations'))`;
      const metadata = await transaction<{ exists: boolean }[]>`
        select to_regclass('seniorsocial_meta.migrations') is not null as exists
      `;
      if (!metadata[0]?.exists) return;
      const applied = await transaction<{ name: string }[]>`
        select name from seniorsocial_meta.migrations order by name desc
      `;
      for (const { name } of applied) {
        const downPath = join(migrationDirectory, name.replace(/\.sql$/u, '.down.sql'));
        const source = await readFile(downPath, 'utf8');
        await transaction.unsafe(source);
        await transaction`delete from seniorsocial_meta.migrations where name = ${name}`;
        revertedNames.push(name);
      }
    });
    for (const name of revertedNames) console.log(`Reverted ${name}`);
  } finally {
    await client.end();
  }
}

const direction = process.argv[2] ?? 'up';
if (direction === 'up') await migrateUp();
else if (direction === 'down') await migrateDown();
else throw new Error('Migration direction must be "up" or "down"');
