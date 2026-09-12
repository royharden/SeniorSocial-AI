import { appendAudit } from '@seniorsocial/audit';
import { createDatabaseClient, withOrg } from '@seniorsocial/db';
import { createServicesRepository, type OrgTransaction, type ServicesRepository } from '@seniorsocial/services';

let repository: ServicesRepository | undefined;

export function servicesRepository(): ServicesRepository {
  if (repository) return repository;
  const client = createDatabaseClient();
  const transaction: OrgTransaction = (orgId, work) => withOrg(client, orgId, reserved => work({
    query: (text, values) => reserved.unsafe(text, [...values]),
    audit: intent => appendAudit(reserved, intent).then(() => undefined),
  }));
  repository = createServicesRepository(transaction);
  return repository;
}
