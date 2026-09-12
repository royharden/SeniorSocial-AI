import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabaseClient } from '../../../packages/db/src/index';
import { ADMIN_ID, ORG_ID, journeyEnvironment } from '../journeys/environment.ts';
import journeySetup from '../journeys/global-setup.ts';

export default async function globalSetup() {
  const cleanupJourney = await journeySetup();
  let owner: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    const environment = journeyEnvironment();
    owner = createDatabaseClient(environment.databaseUrl);
    for (const migration of [
      '0090_wp-015_forums.sql', '0100_wp-016_messaging.sql', '0101_wp-015_message_moderation.sql',
      '0120_wp-018_intake.sql', '0130_wp-019_admin_content.sql', '0140_wp-020_reporting.sql',
      '0150_wp-021_translations.sql',
    ]) await owner.unsafe(await readFile(resolve(process.cwd(), 'packages/db/migrations', migration), 'utf8'));
    await owner.begin(async transaction => {
      await transaction`SELECT set_config('app.current_org_id',${ORG_ID},true)`;
      const rows = await transaction<{ granted: boolean }[]>`SELECT wp021_grant_translation_reviewer(
        ${ORG_ID},${ADMIN_ID},'Synthetic qualified Spanish reviewer',${ADMIN_ID},'WP-032 credentialed browser grant') AS granted`;
      if (!rows[0]?.granted) throw new Error('WP-032 reviewer grant failed');
    });
    await owner.end(); owner = undefined;
    return cleanupJourney;
  } catch (setupError) {
    const cleanupErrors: unknown[] = [];
    try { if (owner) await owner.end(); } catch (error) { cleanupErrors.push(error); }
    try { await cleanupJourney(); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError([setupError, ...cleanupErrors], 'WP-032 setup and cleanup failed');
    throw setupError;
  }
}
