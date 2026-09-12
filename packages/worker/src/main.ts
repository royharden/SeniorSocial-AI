import { PgBoss } from 'pg-boss';
import { createDatabaseClient, withOrg } from '@seniorsocial/db';
import { createMessageNoticeAuthorization } from '@seniorsocial/messaging';
import { createRuntime } from '../../notify/src/runtime.ts';
import { createBossQueue, createConsumer, postgresWorkerLookup, registerConsumers } from './bridge.ts';
import { createPrintService } from '../../notify/src/schedule.ts';
import { createPrintConsumer, registerPrintConsumer } from './print.ts';
import { createWorkerHealth } from './health.ts';
import { WorkerLifecycle } from './lifecycle.ts';
import { workerConfiguration } from './config.ts';
import { reportWorkerStartupFailure } from './diagnostics.ts';
import { createWorkerScheduleSource } from './schedule.ts';

async function main() {
  const { connectionString, orgId, healthPort } = workerConfiguration(process.env);
  const client = createDatabaseClient();
  // Schema installation/migration is an administrative deployment step. The
  // runtime role can operate only inside the provisioned pg-boss schema and
  // startup fails closed when its version does not match this dependency.
  const boss = new PgBoss({ connectionString, migrate: false });
  const notify = createRuntime(client, createBossQueue(boss), createMessageNoticeAuthorization(client));
  const schedule = createWorkerScheduleSource(client);
  const health = createWorkerHealth(healthPort);
  const lifecycle = new WorkerLifecycle({
    health,
    boss,
    database: client,
    registerNotificationConsumers: () => registerConsumers(boss, createConsumer(postgresWorkerLookup(client), notify, orgId)),
    registerPrintConsumer: () => registerPrintConsumer(boss, createPrintConsumer(createPrintService(client, schedule), orgId)),
    recover: async () => {
      const recipients = await withOrg(client, orgId, sql => sql<{user_id: string}[]>`
      select user_id from notification_outbox where org_id = ${orgId}
        and (state in ('pending', 'send_failed') or (state = 'delivered' and payload->>'purpose' = 'event_reminder'))
      union select user_id from notification_audit_pending where org_id = ${orgId} and not emitted`);
      for (const recipient of recipients) await notify.recover({ orgId, userId: recipient.user_id });
    },
  });
  boss.on('error', () => {
    lifecycle.queueFailed();
    process.stderr.write('Notification queue error\n');
  });
  const shutdown = () => {
    void lifecycle.shutdown().catch(() => {
      process.stderr.write('Worker shutdown failed\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await lifecycle.start();
  process.stdout.write('Notification and print worker ready; local providers only\n');
}

await main().catch(reportWorkerStartupFailure);
