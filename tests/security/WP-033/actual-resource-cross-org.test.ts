import { describe, expect, it } from 'vitest';
import { createUpdateUserHandler } from '../../../apps/web/app/api/v1/admin/users/[userId]/route.ts';
import { createGetExportHandler } from '../../../apps/web/app/api/v1/admin/exports/[exportId]/route.ts';
import { createSetFlagHandler } from '../../../apps/web/app/api/v1/admin/flags/[flagKey]/route.ts';
import { createAdminService } from '../../../packages/admin/src/index.ts';
import type { AdminRepository } from '../../../packages/admin/src/index.ts';
import { MemoryCaregiverRepository, createCaregiverService } from '../../../packages/caregiver/src/index.ts';
import { MemoryRideRepository, createRideService } from '../../../packages/rides/src/index.ts';
import { AssistanceService, MemoryAssistanceRepository } from '../../../packages/assistance/src/index.ts';
import { createForums } from '../../../packages/forums/src/index.ts';
import type { ForumRepository } from '../../../packages/forums/src/index.ts';
import { createReportingService } from '../../../packages/reporting/src/index.ts';
import type { ReportingRepository } from '../../../packages/reporting/src/index.ts';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const TARGET_ID = '22222222-2222-4222-8222-222222222223';
const RESIDENT_B = '22222222-2222-4222-8222-222222222224';
const CAREGIVER_B = '22222222-2222-4222-8222-222222222225';
const actors = [
  ['resident', 'senior'], ['caregiver', 'caregiver'], ['staff clerk', 'staff'],
  ['staff dispatcher', 'staff'], ['org admin', 'admin'], ['demo reviewer', 'support'],
] as const;
type MatrixActor = { id: string; userId: string; orgId: string; roles: readonly [typeof actors[number][1]] };

async function observedStatus(run: () => Promise<unknown>): Promise<number> {
  try {
    const result = await run();
    if (result instanceof Response) return result.status;
    if (result && typeof result === 'object' && 'status' in result && typeof result.status === 'number') return result.status;
    return 200;
  } catch (error) {
    const candidate = error as { status?: unknown; message?: unknown };
    if (typeof candidate.status === 'number') return candidate.status;
    if (candidate.message === 'not_found') return 404;
    if (candidate.message === 'forbidden') return 403;
    throw error;
  }
}

function profileBoundary(actor: MatrixActor): Promise<Response> {
  const repository = {
    findUser: (tenant: string, userId: string) => Promise.resolve(tenant === ORG_B && userId === TARGET_ID ? {
      id: TARGET_ID, org_id: ORG_B, display_name: 'Other resident', roles: ['senior'], account_state: 'active', version: 1,
    } : null),
    updateUser: () => Promise.reject(new Error('cross-org profile reached mutation after tenant lookup')),
  } as unknown as AdminRepository;
  const handler = createUpdateUserHandler(() => createAdminService(repository), () => Promise.resolve(actor));
  return handler(new Request('http://local/api/v1/admin/users/' + TARGET_ID, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_version: 1, account_state: 'active' }) }),
  { params: Promise.resolve({ userId: TARGET_ID }) });
}

async function caregiverScopeBoundary(actor: MatrixActor) {
  const repository = new MemoryCaregiverRepository();
  await repository.transaction(ORG_B, async transaction => {
    const now = new Date('2026-09-11T12:00:00Z');
    await transaction.insertInvitation({ id: TARGET_ID, orgId: ORG_B, residentId: RESIDENT_B,
      recipientDigest: 'digest', tokenDigest: 'token-digest', relationshipNote: null,
      createdAt: now, expiresAt: new Date('2026-09-12T12:00:00Z'), acceptedAt: null, caregiverId: null });
    await transaction.acceptInvitation(TARGET_ID, CAREGIVER_B, TARGET_ID, now);
  });
  const service = createCaregiverService({ repository,
    delivery: { enqueue: () => Promise.resolve({ status: 'pending', synthetic: true }) },
    recipientDigestKey: 'wp033-cross-org-recipient-key-32', token: () => 'token', id: () => TARGET_ID,
    clock: () => new Date('2026-09-11T12:00:00Z') });
  return service.setScopes(actor, TARGET_ID, { scopes: [{ key: 'view_profile', granted: true, granted_at: null }], read_back_confirmed: true });
}

function rideBoundary(actor: MatrixActor) {
  const repository = new MemoryRideRepository();
  repository.rides.push({ id: TARGET_ID, orgId: ORG_B, residentId: RESIDENT_B, requestedByActorId: RESIDENT_B,
    purpose: 'clinic', mode: 'partner_van', pickupAt: '2026-10-01T12:00:00.000Z', pickupTz: 'America/New_York',
    pickupLocation: 'home', destinationLocation: 'clinic', returnNeeded: false, accessibilityConditions: [],
    state: 'requested', sendState: 'not_sent', dispatchReference: null, createdAt: '2026-09-11T12:00:00.000Z',
    transitions: [], confirmedByActor: null, confirmedAt: null });
  const never = () => Promise.reject(new Error('cross-org ride reached authorization after tenant lookup'));
  const service = createRideService({ repository, authorization: { canRead: never, canCreate: never,
    canListQueue: never, canTransition: never }, dispatch: { submit: never }, confirmation: { evidence: never },
  events: { publish: () => Promise.resolve() }, jobs: { enqueue: () => Promise.resolve() } });
  return service.get(actor, TARGET_ID);
}

function assistanceBoundary(actor: MatrixActor) {
  const repository = new MemoryAssistanceRepository();
  repository.requests.set(TARGET_ID, { id: TARGET_ID, orgId: ORG_B, requesterId: RESIDENT_B, summary: 'other tenant',
    locale: 'en', triageCategory: 'general', triageSource: 'rules', state: 'pending_unowned', ownerId: null,
    afterHours: false, slaDueAt: new Date('2026-09-12T12:00:00Z'), slaBreachedAt: null,
    createdAt: new Date('2026-09-11T12:00:00Z') });
  const service = new AssistanceService({ repository,
    authorization: { authorize: () => Promise.reject(new Error('cross-org assistance reached authorization after tenant lookup')) },
    codec: { seal: value => Promise.resolve(value), open: value => Promise.resolve(value) },
    ids: { next: () => TARGET_ID }, hours: { isAfterHours: () => false } });
  return service.get({ orgId: actor.orgId, userId: actor.id, roles: actor.roles }, TARGET_ID);
}

function forumBoundary(actor: MatrixActor) {
  const repository = {
    listPosts: (identity: { orgId: string }) => Promise.resolve(identity.orgId === ORG_B
      ? { items: [], meta: { next_cursor: null, total_known: true as const } } : null),
  } as unknown as ForumRepository;
  return createForums(repository).listPosts({ orgId: actor.orgId, userId: actor.id, roles: actor.roles }, TARGET_ID);
}

function exportBoundary(actor: MatrixActor): Promise<Response> {
  const repository = { findExport: (tenant: string) => Promise.resolve(tenant === ORG_B ? {} : null) } as unknown as ReportingRepository;
  const individual = {
    create: () => Promise.reject(new Error('status probe must not create an export')),
    get: () => Promise.resolve(null),
    download: () => Promise.resolve(null),
  };
  const handler = createGetExportHandler(
    () => createReportingService(repository),
    () => Promise.resolve(actor),
    () => individual,
  );
  return handler(new Request('http://local/api/v1/admin/exports/' + TARGET_ID), { params: Promise.resolve({ exportId: TARGET_ID }) });
}

async function adminConfigBoundary(actor: MatrixActor): Promise<{ response: Response; writtenOrg: string | null }> {
  let writtenOrg: string | null = null;
  const handler = createSetFlagHandler({
    authorize: () => Promise.resolve({ orgId: actor.orgId, userId: actor.id, roles: actor.roles, flagScope: 'org' }),
    flags: { set: (_flag, enabled, _reason, context) => {
      writtenOrg = context.orgId;
      return Promise.resolve({ enabled, org_id: context.orgId });
    } },
  });
  const response = await handler(new Request(`http://local/api/v1/admin/flags/ai.master?org_id=${ORG_B}`, { method: 'PATCH',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false, reason: 'cross-org probe' }) }),
  { params: Promise.resolve({ flagKey: 'ai.master' }) });
  return { response, writtenOrg };
}

const resources = [
  ['resident profile', profileBoundary, 'packages/admin + apps/web/app/api/v1/admin/users/[userId]/route.ts'],
  ['caregiver scope', caregiverScopeBoundary, 'packages/caregiver'],
  ['ride request', rideBoundary, 'packages/rides'],
  ['assistance request', assistanceBoundary, 'packages/assistance'],
  ['forum thread', forumBoundary, 'packages/forums'],
  ['export', exportBoundary, 'packages/reporting + apps/web/app/api/v1/admin/exports/[exportId]/route.ts'],
] as const;

describe('WP-033 actual-resource six-by-seven cross-org matrix', () => {
  const cells = actors.flatMap(([actorName, role], actorIndex) => resources.map(([resourceName, boundary, owner]) => ({
    actorName, resourceName, boundary, owner,
    actor: { id: `11111111-1111-4111-8111-${String(500 + actorIndex).padStart(12, '0')}`,
      userId: `11111111-1111-4111-8111-${String(500 + actorIndex).padStart(12, '0')}`,
      orgId: ORG_A, roles: [role] as const },
  })));

  it('contains the 36 addressable-resource cells', () => { expect(cells).toHaveLength(36); });

  it.each(cells)('$actorName × $resourceName is opaque 404 ($owner)', async ({ actor, boundary }) => {
    // what_bug_this_catches: privilege-first checks or a missing tenant-addressing
    // contract return 403/200 for an org-B identifier and invalidate the exact matrix.
    expect(await observedStatus(() => boundary(actor))).toBe(404);
  });

  it.each(actors.map(([actorName, role], actorIndex) => [actorName, role, actorIndex] as const))(
    '%s × admin config ignores a client-supplied org-B target', async (_actorName, role, actorIndex) => {
    // what_bug_this_catches: treating an attacker-controlled org_id query as the
    // target makes an org-scoped singleton into a cross-tenant mutation surface.
    const actor = { id: `11111111-1111-4111-8111-${String(500 + actorIndex).padStart(12, '0')}`,
      userId: `11111111-1111-4111-8111-${String(500 + actorIndex).padStart(12, '0')}`,
      orgId: ORG_A, roles: [role] as const };
    const result = await adminConfigBoundary(actor);
    expect(result.writtenOrg).not.toBe(ORG_B);
    if (role === 'admin') {
      expect(result.response.status).toBe(200);
      expect(result.writtenOrg).toBe(ORG_A);
      await expect(result.response.json()).resolves.toMatchObject({ org_id: ORG_A });
    } else {
      expect(result.response.status).toBe(403);
      expect(result.writtenOrg).toBeNull();
    }
    },
  );

  it('accounts for all 42 specification cells without inventing an addressable config tenant', () => {
    expect(cells.length + actors.length).toBe(42);
  });
});
