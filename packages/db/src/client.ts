import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

export type DatabaseClient = ReturnType<typeof postgres>;

function sslSetting(): 'require' | false {
  const setting = process.env.DATABASE_SSL ?? 'disable';
  if (setting === 'require') return 'require';
  if (setting === 'disable') return false;
  throw new Error('DATABASE_SSL must be "require" or "disable"');
}

export function createDatabaseClient(url = process.env.DATABASE_URL): DatabaseClient {
  if (!url) throw new Error('DATABASE_URL is required');
  return postgres(url, { max: 10, ssl: sslSetting() });
}

export function createDatabase(client: DatabaseClient) {
  return drizzle(client, { schema });
}
