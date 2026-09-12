import { createHash } from 'node:crypto';
import { assertConstrainedRuntimeRole, createAuthDatabaseClient, type AuthSql } from '../../../../../../packages/auth/src/index';
import {
  createCaregiverService, PostgresCaregiverRepository,
  type CaregiverRepository, type CaregiverService, type InvitationDeliveryPort,
} from '../../../../../../packages/caregiver/src/index';
import { createLocalAdapter } from '../../../../../../packages/notify/src/index';
import { configuredOrgId, readCookie, SESSION_COOKIE, withAuthService } from '../../../(auth)/auth/_shared';
import type { CaregiverRouteDependencies } from './_shared';

type RuntimeClient = ReturnType<typeof createAuthDatabaseClient>;
let client: RuntimeClient | undefined;
let testDelivery: InvitationDeliveryPort | undefined;
let testMailpitTransport: typeof fetch | undefined;
let testRepository: CaregiverRepository | undefined;
let cachedService: CaregiverService | undefined;
let cachedRecipientDigestKey: string | undefined;

const nonInvitationRecipientKey = 'caregiver-non-invitation-runtime-only';

function database(): RuntimeClient { return client ??= createAuthDatabaseClient(); }
function repository(): CaregiverRepository {
  return testRepository ?? new PostgresCaregiverRepository(database(), sql => assertConstrainedRuntimeRole(sql as unknown as AuthSql));
}
function localCaptureDelivery(): InvitationDeliveryPort {
  const mailpitUrl = process.env.MAILPIT_URL;
  if (!mailpitUrl) throw new Error('MAILPIT_URL is required');
  const adapter = createLocalAdapter(mailpitUrl, testMailpitTransport ?? fetch);
  return { enqueue: async (_identity, request) => {
    if (request.synthetic !== true) throw new Error('Only synthetic caregiver invitations may be captured');
    const confirmation = await adapter.send({
      jobId: request.idempotencyKey,
      channel: 'email',
      idempotencyKey: createHash('sha256').update(request.idempotencyKey).digest('hex'),
      destination: 'capture@example.invalid',
      body: `Caregiver invitation token: ${request.params.invitation_token}\nExpires: ${request.params.expires_at}`,
    });
    if (confirmation.outcome !== 'confirmed') throw new Error('Mailpit did not confirm local capture');
    // A confirmed local-only capture is queued/pending product delivery, never
    // evidence that a real recipient received the invitation.
    return { status: 'pending', synthetic: true };
  } };
}
const delivery: InvitationDeliveryPort = {
  enqueue: (...args) => (testDelivery ?? localCaptureDelivery()).enqueue(...args),
};

function configuredService(requiresRecipientKey = false): CaregiverService {
  const recipientDigestKey = process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
  if (requiresRecipientKey && !recipientDigestKey) throw new Error('CAREGIVER_RECIPIENT_HMAC_KEY is required');
  const effectiveKey = recipientDigestKey ?? nonInvitationRecipientKey;
  if (cachedService && cachedRecipientDigestKey === effectiveKey) return cachedService;
  cachedService = createCaregiverService({ repository: repository(), delivery, recipientDigestKey: effectiveKey });
  cachedRecipientDigestKey = effectiveKey;
  return cachedService;
}

const service: CaregiverService = {
  invite: (...args) => configuredService(true).invite(...args),
  accept: (...args) => configuredService(true).accept(...args),
  links: (...args) => configuredService().links(...args),
  myCaregivers: (...args) => configuredService().myCaregivers(...args),
  setScopes: (...args) => configuredService().setScopes(...args),
  revoke: (...args) => configuredService().revoke(...args),
  authorize: (...args) => configuredService().authorize(...args),
};

export const runtimeDependencies: CaregiverRouteDependencies = {
  authorize: async request => {
    try {
      const orgId = configuredOrgId(request);
      const token = readCookie(request, SESSION_COOKIE);
      if (!token) return null;
      const session = await withAuthService(orgId, auth => auth.session(orgId, token));
      if (!session) return null;
      return { orgId: session.orgId, userId: session.userId, roles: session.roles };
    } catch { return null; }
  },
  service,
};

/** Test-only injection proves the real route exports without enabling outbound delivery. */
export function setCaregiverDeliveryForTests(delivery: InvitationDeliveryPort | undefined): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('caregiver delivery injection is test-only');
  testDelivery = delivery; cachedService = undefined; cachedRecipientDigestKey = undefined;
}

export function setCaregiverMailpitTransportForTests(transport: typeof fetch | undefined): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('caregiver Mailpit transport injection is test-only');
  testMailpitTransport = transport; cachedService = undefined; cachedRecipientDigestKey = undefined;
}

export function setCaregiverRepositoryForTests(repository: CaregiverRepository | undefined): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('caregiver repository injection is test-only');
  testRepository = repository; cachedService = undefined; cachedRecipientDigestKey = undefined;
}

export async function closeCaregiverRuntimeForTests(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') throw new Error('caregiver runtime close is test-only');
  if (client) await client.end();
  client = undefined; cachedService = undefined; cachedRecipientDigestKey = undefined;
  testDelivery = undefined; testMailpitTransport = undefined; testRepository = undefined;
}
