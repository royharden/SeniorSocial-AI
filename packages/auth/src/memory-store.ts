import { equalDigest } from './crypto';
import type {
  AuthResult,
  AuthStore,
  AuthUser,
  DemoAccountInput,
  NewSession,
  NewVerification,
  SessionRecord,
  RateLimitDecision,
  RateLimitIncrement,
  VerificationMethod,
} from './types';

/* eslint-disable @typescript-eslint/require-await -- deterministic in-memory adapter implements the asynchronous store contract. */

interface VerificationRow extends NewVerification {
  consumedAt: Date | null;
  failedAttempts: number;
}

interface DemoRow extends DemoAccountInput {
  usedAt: Date | null;
}

interface SessionRow extends NewSession {
  revokedAt: Date | null;
}

export class MemoryAuthStore implements AuthStore {
  readonly users: AuthUser[];
  readonly verifications: VerificationRow[] = [];
  readonly demoAccounts: DemoRow[] = [];
  readonly sessions: SessionRow[] = [];
  readonly identifiers = new Map<string, string>();
  readonly rateLimits = new Map<string, { windowStartedAt: Date; count: number }>();

  constructor(users: AuthUser[] = []) {
    this.users = structuredClone(users);
  }

  addIdentifier(orgId: string, method: VerificationMethod, identifier: string, userId: string): void {
    this.identifiers.set(`${orgId}:${method}:${identifier}`, userId);
  }

  async findUserByIdentifier(orgId: string, method: VerificationMethod, identifier: string): Promise<AuthUser | null> {
    const userId = this.identifiers.get(`${orgId}:${method}:${identifier}`);
    return this.users.find(user => user.orgId === orgId && user.id === userId) ?? null;
  }

  async createVerification(input: NewVerification): Promise<void> {
    for (const row of this.verifications) {
      if (row.orgId === input.orgId && row.userId === input.userId && row.method === input.method && !row.consumedAt) {
        row.consumedAt = new Date();
      }
    }
    this.verifications.push({ ...input, consumedAt: null, failedAttempts: 0 });
  }

  async consumeVerification(input: {
    orgId: string;
    method: VerificationMethod | undefined;
    credentialDigest: string;
    browserNonceDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>> {
    const row = this.verifications.find(candidate =>
      candidate.orgId === input.orgId
      && (input.method === undefined || candidate.method === input.method)
      && candidate.consumedAt === null
      && equalDigest(candidate.credentialDigest, input.credentialDigest));
    if (!row || row.expiresAt <= input.now || row.failedAttempts >= 5) {
      const latest = this.verifications.find(candidate =>
        candidate.orgId === input.orgId
        && (input.method === undefined || candidate.method === input.method)
        && candidate.consumedAt === null
        && equalDigest(candidate.browserNonceDigest, input.browserNonceDigest));
      if (latest && latest.expiresAt > input.now) {
        latest.failedAttempts += 1;
        if (latest.failedAttempts >= 5) latest.consumedAt = input.now;
      }
      return { ok: false, reason: 'invalid_or_expired' };
    }
    if (!equalDigest(row.browserNonceDigest, input.browserNonceDigest)) {
      row.failedAttempts += 1;
      if (row.failedAttempts >= 5) row.consumedAt = input.now;
      return { ok: false, reason: 'wrong_device' };
    }
    row.consumedAt = input.now;
    const user = this.users.find(candidate => candidate.orgId === input.orgId && candidate.id === row.userId);
    if (!user) return { ok: false, reason: 'invalid_or_expired' };
    if (user.accountState !== 'active') return { ok: false, reason: 'account_inactive' };
    return { ok: true, value: structuredClone(user) };
  }

  async consumeDemoAccount(input: {
    orgId: string;
    codeDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>> {
    const row = this.demoAccounts.find(candidate =>
      candidate.orgId === input.orgId
      && candidate.usedAt === null
      && equalDigest(candidate.codeDigest, input.codeDigest));
    if (!row) return { ok: false, reason: 'invalid_or_expired' };
    if (row.expiresAt <= input.now) return { ok: false, reason: 'demo_expired' };
    row.usedAt = input.now;
    const user = this.users.find(candidate => candidate.orgId === input.orgId && candidate.id === row.userId);
    if (!user || !user.isDemo) return { ok: false, reason: 'invalid_or_expired' };
    if (user.accountState !== 'active') return { ok: false, reason: 'account_inactive' };
    return { ok: true, value: structuredClone(user) };
  }

  async createDemoAccount(input: DemoAccountInput): Promise<void> {
    const existing = this.demoAccounts.find(row => row.orgId === input.orgId && row.userId === input.userId);
    if (existing) {
      Object.assign(existing, input, { usedAt: null });
      return;
    }
    this.demoAccounts.push({ ...input, usedAt: null });
  }

  async createSession(input: NewSession): Promise<void> {
    this.sessions.push({ ...input, revokedAt: null });
  }

  async findSession(orgId: string, tokenDigest: string, now: Date): Promise<SessionRecord | null> {
    const row = this.sessions.find(candidate =>
      candidate.orgId === orgId
      && candidate.revokedAt === null
      && candidate.expiresAt > now
      && equalDigest(candidate.tokenDigest, tokenDigest));
    if (!row) return null;
    const user = this.users.find(candidate => candidate.orgId === orgId && candidate.id === row.userId);
    if (!user || user.accountState !== 'active') return null;
    return {
      orgId,
      userId: row.userId,
      roles: structuredClone(user.roles),
      expiresAt: row.expiresAt,
      isDemo: row.isDemo,
    };
  }

  async revokeSession(orgId: string, tokenDigest: string, now: Date): Promise<boolean> {
    const row = this.sessions.find(candidate =>
      candidate.orgId === orgId && candidate.revokedAt === null && equalDigest(candidate.tokenDigest, tokenDigest));
    if (!row) return false;
    row.revokedAt = now;
    return true;
  }

  async incrementRateLimit(input: RateLimitIncrement): Promise<RateLimitDecision> {
    const key = `${input.orgId}:${input.purpose}:${input.subjectDigest}`;
    const current = this.rateLimits.get(key);
    const elapsed = current ? input.now.getTime() - current.windowStartedAt.getTime() : Number.POSITIVE_INFINITY;
    const row = !current || elapsed >= input.windowSeconds * 1000
      ? { windowStartedAt: input.now, count: 1 }
      : { windowStartedAt: current.windowStartedAt, count: current.count + 1 };
    this.rateLimits.set(key, row);
    const retryAfterSeconds = Math.max(0, Math.ceil(
      (row.windowStartedAt.getTime() + input.windowSeconds * 1000 - input.now.getTime()) / 1000,
    ));
    return { allowed: row.count <= input.limit, count: row.count, retryAfterSeconds };
  }
}
