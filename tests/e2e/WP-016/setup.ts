import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabaseClient } from '../../../packages/db/src/index.ts';
import { digestSecret } from '../../../packages/auth/src/crypto.ts';

export default async function setup() {
  const cluster = process.env.MESSAGING_TEST_CLUSTER_URL!;
  const name = process.env.WP016_BROWSER_DB!;
  const target = new URL(cluster);
  if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.includes('wp016_test') || !/^wp016_test_browser_\d+_\d+$/.test(name)) throw new Error('Dedicated local browser database required');
  const admin = createDatabaseClient(cluster);
  await admin.unsafe(`create database "${name}"`);
  target.pathname = `/${name}`;
  const owner = createDatabaseClient(target.toString());
  try {
    for (const file of [
      '0001_wp-003_core_tables.sql',
      '0010_wp-004_auth.sql',
      '0011_wp-004_auth_rate_limits.sql',
      '0040_wp-009_notify.sql',
      '0090_wp-015_forums.sql',
      '0100_wp-016_messaging.sql',
    ])
      await owner.unsafe(await readFile(resolve('packages/db/migrations', file), 'utf8'));
    await owner.unsafe(`create role "${name}_app" login password 'wp016_test_only' nosuperuser nobypassrls`);
    await owner.unsafe(`grant seniorsocial_app to "${name}_app"`);
    const org = '10000000-0000-4000-8000-000000000001';
    await owner`insert into orgs(id,name,slug) values(${org},'Browser test',${name})`;
    for (const suffix of ['11', '12', '21', '22']) {
      const user = `10000000-0000-4000-8000-0000000000${suffix}`;
      await owner`insert into users(id,org_id,display_name) values(${user},${org},'Synthetic resident')`;
      await owner`insert into user_roles(org_id,user_id,role) values(${org},${user},'senior')`;
      await owner`insert into sessions(org_id,user_id,token_digest,expires_at) values(${org},${user},${digestSecret(`wp016-browser-${suffix}`, 'wp016_browser_test_pepper')},now() + interval '1 hour')`;
    }
  } finally { await owner.end(); }
  return async () => { await admin.unsafe(`drop database "${name}" with (force)`); await admin.unsafe(`drop role "${name}_app"`); await admin.end(); };
}
