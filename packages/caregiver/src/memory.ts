import type {
  AtomicAudit, CaregiverRepository, CaregiverTransaction, ReadBackRecord, StoredInvitation, StoredLink,
  CaregiverScopeKey,
} from './types.ts';

interface State { invitations: StoredInvitation[]; links: StoredLink[]; audits: AtomicAudit[]; readBacks: ReadBackRecord[] }
const copy = <T>(value: T): T => structuredClone(value);

export class MemoryCaregiverRepository implements CaregiverRepository {
  private state: State = { invitations: [], links: [], audits: [], readBacks: [] };
  constructor(private readonly recipients: Readonly<Record<string, readonly string[]>> = {}) {}
  private transactionTail: Promise<void> = Promise.resolve();
  async transaction<T>(orgId: string, work: (transaction: CaregiverTransaction) => Promise<T>): Promise<T> {
    const predecessor = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>(resolve => { release = resolve; });
    await predecessor;
    try {
    const draft = copy(this.state);
    const ownLink = (id: string) => draft.links.find(link => link.orgId === orgId && link.id === id);
    const transaction: CaregiverTransaction = {
      insertInvitation: invitation => { draft.invitations.push(copy(invitation)); return Promise.resolve(); },
      invitationByTokenDigest: tokenDigest => Promise.resolve(copy(draft.invitations.find(item => item.orgId === orgId && item.tokenDigest === tokenDigest) ?? null)),
      acceptInvitation: (invitationId, caregiverId, linkId, at) => {
        const invitation = draft.invitations.find(item => item.orgId === orgId && item.id === invitationId);
        if (!invitation) throw new Error('Invitation disappeared');
        invitation.acceptedAt = at; invitation.caregiverId = caregiverId;
        const link: StoredLink = { id: linkId, orgId, residentId: invitation.residentId, caregiverId, state: 'pending', scopes: [] };
        draft.links.push(link); return Promise.resolve(copy(link));
      },
      linkById: linkId => Promise.resolve(copy(ownLink(linkId) ?? null)),
      linksForCaregiver: caregiverId => Promise.resolve(copy(draft.links.filter(link => link.orgId === orgId && link.caregiverId === caregiverId))),
      linksForResident: residentId => Promise.resolve(copy(draft.links.filter(link => link.orgId === orgId && link.residentId === residentId))),
      accountRecipients: userId => Promise.resolve([...(this.recipients[userId] ?? [])]),
      replaceScopes: (linkId, keys, at) => {
        const link = ownLink(linkId); if (!link) throw new Error('Link disappeared');
        const desired = new Set<CaregiverScopeKey>(keys);
        for (const scope of link.scopes) if (scope.revokedAt === null && !desired.has(scope.key)) scope.revokedAt = at;
        for (const key of desired) if (!link.scopes.some(scope => scope.key === key && scope.revokedAt === null))
          link.scopes.push({ key, grantedAt: at, revokedAt: null });
        link.state = desired.size > 0 ? 'active' : 'pending'; return Promise.resolve(copy(link));
      },
      revokeLink: (linkId, at) => {
        const link = ownLink(linkId); if (!link) throw new Error('Link disappeared');
        link.state = 'revoked'; for (const scope of link.scopes) if (scope.revokedAt === null) scope.revokedAt = at; return Promise.resolve(copy(link));
      },
      appendReadBack: record => { draft.readBacks.push(copy(record)); return Promise.resolve(); },
      appendAudit: event => { draft.audits.push(copy(event)); return Promise.resolve(); },
    };
      const result = await work(transaction); this.state = draft; return result;
    } finally { release(); }
  }
  snapshot(): State { return copy(this.state); }
}
