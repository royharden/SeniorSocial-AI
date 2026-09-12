import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  caregiverScopeKeys, caregiverScopeRules, delegableCaregiverScopes,
  type CaregiverInvitation, type CaregiverInviteInput, type CaregiverLink, type CaregiverRepository,
  type CaregiverScopeKey, type ConsentScopeSet, type InvitationDeliveryPort, type SessionIdentity, type StoredLink,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const phone = /^\+[1-9][0-9]{7,14}$/u;
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/u;
const invitationTtlMs = 24 * 60 * 60 * 1000;
const delegable = new Set<CaregiverScopeKey>(delegableCaregiverScopes);

export class CaregiverProblem extends Error {
  constructor(readonly status: 400 | 404 | 410, readonly code: 'invalid_request' | 'not_found' | 'invitation_expired') { super(code); }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function sameDigest(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
function normalizeRecipient(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!email.test(normalized) && !phone.test(normalized)) throw new CaregiverProblem(400, 'invalid_request');
  return normalized;
}
function validIdentity(identity: SessionIdentity): boolean {
  return uuid.test(identity.orgId) && uuid.test(identity.userId) && identity.roles.length > 0;
}
function exactObject(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key));
}
function invitationInput(value: unknown): CaregiverInviteInput {
  if (!exactObject(value, ['email_or_phone', 'relationship_note']) || typeof value.email_or_phone !== 'string'
    || ('relationship_note' in value && typeof value.relationship_note !== 'string')) throw new CaregiverProblem(400, 'invalid_request');
  const note = typeof value.relationship_note === 'string' ? value.relationship_note.trim() : undefined;
  if (note && note.length > 500) throw new CaregiverProblem(400, 'invalid_request');
  return { email_or_phone: normalizeRecipient(value.email_or_phone), ...(note ? { relationship_note: note } : {}) };
}
function consentInput(value: unknown): ConsentScopeSet {
  if (!exactObject(value, ['scopes', 'read_back_confirmed']) || !Array.isArray(value.scopes)
    || value.scopes.length < 1 || value.scopes.length > 20 || typeof value.read_back_confirmed !== 'boolean')
    throw new CaregiverProblem(400, 'invalid_request');
  const seen = new Set<string>();
  const scopes = value.scopes.map(raw => {
    if (!exactObject(raw, ['key', 'granted', 'granted_at']) || typeof raw.key !== 'string'
      || !caregiverScopeKeys.includes(raw.key as CaregiverScopeKey) || typeof raw.granted !== 'boolean'
      || ('granted_at' in raw && raw.granted_at !== null && typeof raw.granted_at !== 'string') || seen.has(raw.key))
      throw new CaregiverProblem(400, 'invalid_request');
    seen.add(raw.key);
    return { key: raw.key as CaregiverScopeKey, granted: raw.granted, granted_at: null };
  });
  return { scopes, read_back_confirmed: value.read_back_confirmed };
}
function publicLink(link: StoredLink): CaregiverLink {
  const active = new Map(link.scopes.filter(scope => scope.revokedAt === null).map(scope => [scope.key, scope.grantedAt]));
  return {
    id: link.id, resident_id: link.residentId, caregiver_id: link.caregiverId,
    scopes: caregiverScopeKeys.map(key => ({ key, granted: active.has(key), granted_at: active.get(key)?.toISOString() ?? null })),
    state: link.state,
  };
}

export interface CaregiverServiceDependencies {
  repository: CaregiverRepository; delivery: InvitationDeliveryPort; clock?: () => Date;
  token?: () => string; id?: () => string; recipientDigestKey: string;
}

export function createCaregiverService(dependencies: CaregiverServiceDependencies) {
  const clock = dependencies.clock ?? (() => new Date());
  if (dependencies.recipientDigestKey.length < 32) throw new Error('recipientDigestKey must contain at least 32 characters');
  const recipientDigest = (value: string) => createHmac('sha256', dependencies.recipientDigestKey).update(value).digest('hex');
  const tokenFactory = dependencies.token ?? (() => randomBytes(32).toString('base64url'));
  const idFactory = dependencies.id ?? randomUUID;
  async function deny(identity: SessionIdentity, reason = 'caregiver_not_found'): Promise<never> {
    if (validIdentity(identity)) await dependencies.repository.transaction(identity.orgId, transaction => transaction.appendAudit({
      action: 'caregiver.denied', actorId: identity.userId, grantorId: identity.userId, caregiverId: null,
      resource: 'caregiver:restricted', resourceAction: 'access', outcome: 'denied', reason,
    }));
    throw new CaregiverProblem(404, 'not_found');
  }
  async function invite(identity: SessionIdentity, rawInput: unknown): Promise<CaregiverInvitation> {
    if (!validIdentity(identity) || !identity.roles.includes('senior')) return deny(identity);
    const input = invitationInput(rawInput);
    const rawToken = tokenFactory();
    if (!tokenPattern.test(rawToken)) throw new Error('Token factory returned an unsafe token');
    const now = clock();
    const invitation = { id: idFactory(), orgId: identity.orgId, residentId: identity.userId,
      recipientDigest: recipientDigest(input.email_or_phone), tokenDigest: digest(rawToken),
      relationshipNote: input.relationship_note ?? null,
      createdAt: now, expiresAt: new Date(now.getTime() + invitationTtlMs), acceptedAt: null, caregiverId: null };
    const delivery = await dependencies.delivery.enqueue({ orgId: identity.orgId, userId: identity.userId }, {
      recipient: input.email_or_phone, channel: input.email_or_phone.includes('@') ? 'email' : 'sms', purpose: 'task_notice',
      idempotencyKey: `caregiver-invitation:${invitation.id}`, template: 'caregiver.invitation',
      params: { invitation_token: rawToken, expires_at: invitation.expiresAt.toISOString() }, synthetic: true,
    });
    if (delivery.status !== 'pending' || delivery.synthetic !== true) throw new Error('Caregiver invitation capture was not accepted');
    await dependencies.repository.transaction(identity.orgId, async transaction => {
      await transaction.insertInvitation(invitation);
      await transaction.appendAudit({ action: 'caregiver.invited', actorId: identity.userId, grantorId: identity.userId,
        caregiverId: null, resource: `caregiver_invitation:${invitation.id}`, resourceAction: 'invite', outcome: 'allowed', reason: 'caregiver_invited' });
    });
    return { id: invitation.id, expires_at: invitation.expiresAt.toISOString() };
  }
  async function accept(identity: SessionIdentity, rawToken: string): Promise<CaregiverLink> {
    if (!validIdentity(identity) || !identity.roles.includes('caregiver') || !tokenPattern.test(rawToken)) return deny(identity);
    const result = await dependencies.repository.transaction(identity.orgId, async transaction => {
      const presentedRecipientDigests = (await transaction.accountRecipients(identity.userId)).flatMap(value => {
        try { return [recipientDigest(normalizeRecipient(value))]; } catch { return []; }
      });
      const invitation = await transaction.invitationByTokenDigest(digest(rawToken));
      if (presentedRecipientDigests.length === 0 || !invitation
        || !presentedRecipientDigests.some(value => sameDigest(invitation.recipientDigest, value)) || invitation.acceptedAt) return null;
      if (invitation.expiresAt.getTime() <= clock().getTime()) return 'expired' as const;
      const link = await transaction.acceptInvitation(invitation.id, identity.userId, idFactory(), clock());
      await transaction.appendAudit({ action: 'caregiver.accepted', actorId: identity.userId, grantorId: invitation.residentId,
        caregiverId: identity.userId, resource: `caregiver_link:${link.id}`, resourceAction: 'accept', outcome: 'allowed', reason: 'caregiver_accepted' });
      return link;
    });
    if (result === 'expired') throw new CaregiverProblem(410, 'invitation_expired');
    if (!result) return deny(identity);
    return publicLink(result);
  }
  async function links(identity: SessionIdentity): Promise<{ items: CaregiverLink[] }> {
    if (!validIdentity(identity) || !identity.roles.includes('caregiver')) return deny(identity);
    return { items: (await dependencies.repository.transaction(identity.orgId, transaction =>
      transaction.linksForCaregiver(identity.userId))).map(publicLink) };
  }
  async function myCaregivers(identity: SessionIdentity): Promise<{ items: CaregiverLink[] }> {
    if (!validIdentity(identity) || !identity.roles.includes('senior')) return deny(identity);
    return { items: (await dependencies.repository.transaction(identity.orgId, transaction =>
      transaction.linksForResident(identity.userId))).map(publicLink) };
  }
  async function setScopes(identity: SessionIdentity, linkId: string, rawInput: unknown): Promise<CaregiverLink> {
    if (!validIdentity(identity) || !identity.roles.includes('senior') || !uuid.test(linkId)) return deny(identity);
    const input = consentInput(rawInput);
    const desired = input.scopes.filter(scope => scope.granted).map(scope => scope.key);
    if ((desired.length > 0 && input.read_back_confirmed !== true) || desired.some(scope => !delegable.has(scope))) return deny(identity);
    const now = clock();
    const result = await dependencies.repository.transaction(identity.orgId, async transaction => {
      const link = await transaction.linkById(linkId);
      if (!link || link.residentId !== identity.userId || link.state === 'revoked') return null;
      const before = new Set(link.scopes.filter(scope => scope.revokedAt === null).map(scope => scope.key));
      const next = await transaction.replaceScopes(linkId, desired, now);
      if (input.read_back_confirmed) await transaction.appendReadBack({
        linkId, residentId: identity.userId, actorId: identity.userId, scopes: desired, confirmedAt: now,
      });
      for (const key of caregiverScopeKeys) {
        const isGranted = desired.includes(key); const wasGranted = before.has(key);
        if (isGranted === wasGranted) continue;
        const rule = caregiverScopeRules[key];
        await transaction.appendAudit({ action: isGranted ? 'consent.granted' : 'consent.revoked', actorId: identity.userId,
          grantorId: identity.userId, caregiverId: link.caregiverId, resource: rule.resource, resourceAction: rule.action,
          outcome: 'allowed', reason: `${key}_${isGranted ? 'granted' : 'revoked'}` });
      }
      return next;
    });
    if (!result) return deny(identity);
    return publicLink(result);
  }
  async function revoke(identity: SessionIdentity, linkId: string): Promise<void> {
    if (!validIdentity(identity) || !identity.roles.includes('senior') || !uuid.test(linkId)) return deny(identity);
    const now = clock();
    const found = await dependencies.repository.transaction(identity.orgId, async transaction => {
      const link = await transaction.linkById(linkId);
      if (!link || link.residentId !== identity.userId || link.state === 'revoked') return false;
      const active = link.scopes.filter(scope => scope.revokedAt === null);
      await transaction.revokeLink(linkId, now);
      for (const scope of active) {
        const rule = caregiverScopeRules[scope.key];
        await transaction.appendAudit({ action: 'consent.revoked', actorId: identity.userId, grantorId: identity.userId,
          caregiverId: link.caregiverId, resource: rule.resource, resourceAction: rule.action,
          outcome: 'allowed', reason: `${scope.key}_revoked` });
      }
      return true;
    });
    if (!found) return deny(identity);
  }
  async function authorize(identity: SessionIdentity, request: { linkId: string; residentId: string; resource: string; action: string }): Promise<boolean> {
    if (!validIdentity(identity) || !identity.roles.includes('caregiver') || !uuid.test(request.linkId) || !uuid.test(request.residentId)) return false;
    return dependencies.repository.transaction(identity.orgId, async transaction => {
      const link = await transaction.linkById(request.linkId);
      if (!link || link.state !== 'active' || link.caregiverId !== identity.userId || link.residentId !== request.residentId) return false;
      return link.scopes.some(scope => scope.revokedAt === null && delegable.has(scope.key)
        && caregiverScopeRules[scope.key].resource === request.resource && caregiverScopeRules[scope.key].action === request.action);
    });
  }
  return { invite, accept, links, myCaregivers, setScopes, revoke, authorize };
}

export type CaregiverService = ReturnType<typeof createCaregiverService>;
