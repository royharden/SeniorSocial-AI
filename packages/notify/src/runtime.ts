import { withOrg, type DatabaseClient } from '@seniorsocial/db';
import { FlagRepository } from '@seniorsocial/flags';
import { createDurableNotificationAudit } from './audit.ts';
import { createLocalAdapter } from './adapters.ts';
import { createPostgresRepository } from './postgres.ts';
import { createResidentRepository } from './resident.ts';
import { createNotify, minimalNotificationArtifact } from './service.ts';
import type { Authorization, JobQueue } from './types.ts';

export type MessageNotificationAuthorization = (identity: Parameters<Authorization['canNotify']>[0], recipientId: string, conversationId: string) => Promise<boolean>;

export function createRuntime(client: DatabaseClient, queue: JobQueue, messageAuthorization?: MessageNotificationAuthorization) {
  const flags = new FlagRepository(client);
  const authorization: Authorization = {
    async canNotify(identity, recipient, purpose, resourceId) {
      if (purpose === 'message') {
        if (!resourceId || !messageAuthorization) return false;
        return messageAuthorization(identity, recipient, resourceId);
      }
      if (purpose === 'event_reminder') {
        if (!resourceId || identity.userId !== recipient) return false;
        return withOrg(client, identity.orgId, async sql => {
          const rows = await sql<{id: string}[]>`select r.id from event_rsvps r join events e
            on e.org_id = r.org_id and e.id = r.event_id join users u
            on u.org_id = r.org_id and u.id = r.user_id
            where r.org_id = ${identity.orgId} and r.user_id = ${recipient} and r.event_id = ${resourceId}
              and r.state = 'attending' and e.published_at is not null and u.account_state = 'active'`;
          return rows.length === 1;
        });
      }
      // Current self-only authority. Delegated notices require an explicitly
      // integrated consent policy before broadening this boundary.
      if (identity.userId !== recipient) return false;
      return withOrg(client, identity.orgId, async sql => {
        const rows = await sql<{id: string}[]>`select id from users where org_id = ${identity.orgId} and id = ${recipient} and account_state = 'active'`;
        return rows.length === 1;
      });
    },
    canDisclose: () => Promise.resolve(false),
  };
  return createNotify({ repository: createPostgresRepository(client), audit: createDurableNotificationAudit(client), authorization,
    flags: { enabled: (key, org) => flags.readEffective(key, org) }, queue,
    inbox: createResidentRepository(client),
    adapter: createLocalAdapter(process.env.MAILPIT_URL ?? 'http://127.0.0.1:8025'),
    renderer: { destination: () => Promise.resolve('capture@example.invalid'),
      body: job => Promise.resolve(minimalNotificationArtifact(job.payload.locale).body) },
    clock: () => new Date() });
}
