import { randomUUID } from 'node:crypto';
import { DurableAuditSink } from '@seniorsocial/audit';
import { createDatabaseClient } from '@seniorsocial/db';
import { createPolicy, createPostgresConsentRepository } from '../../policy/src/index.ts';
import { AesGcmNarrativeCodec } from './crypto.ts';
import { PostgresAssistanceRepository } from './postgres.ts';
import { AssistanceService } from './service.ts';
import { ZonedBusinessHours } from './triage.ts';

export async function withPostgresAssistanceService<T>(configuration: { encryptionKey: string; timeZone: string }, work: (service: AssistanceService) => Promise<T>): Promise<T> {
  const client = createDatabaseClient();
  try {
    const codec = new AesGcmNarrativeCodec(configuration.encryptionKey);
    const policy = createPolicy(createPostgresConsentRepository(client), new DurableAuditSink(client));
    const service = new AssistanceService({
      repository: new PostgresAssistanceRepository(client, codec), codec,
      ids: { next: randomUUID }, hours: new ZonedBusinessHours(configuration.timeZone),
      authorization: { authorize: async (identity, resource) => {
        const actor = { id: identity.userId, orgId: identity.orgId, roles: identity.roles };
        return (await policy.authorize({
          actor, decisionActor: actor, orgId: identity.orgId,
          resource: { id: resource.resourceId, orgId: identity.orgId, residentId: resource.residentId, kind: 'assistance' },
          action: 'read',
        })).allowed;
      } },
    });
    return await work(service);
  } finally { await client.end(); }
}
