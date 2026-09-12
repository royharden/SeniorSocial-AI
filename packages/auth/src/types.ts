import type { Me } from '../../contracts/src/types';

export const authRoleValues = [
  'senior',
  'caregiver',
  'staff',
  'admin',
  'partner',
  'support',
] as const satisfies Me['roles'];

export type AuthRole = (typeof authRoleValues)[number];
export type VerificationMethod = 'magic_link' | 'sms_code';

export interface AuthUser {
  id: string;
  orgId: string;
  roles: AuthRole[];
  accountState: 'active' | 'held_for_review' | 'deactivated';
  isDemo: boolean;
}

export interface SessionRecord {
  userId: string;
  orgId: string;
  roles: AuthRole[];
  expiresAt: Date;
  isDemo: boolean;
}

export interface IssuedCredential {
  accepted: true;
  /** Present only for the local simulator; delivery adapters must never send it. */
  simulationCredential?: string;
}

export type AuthFailure =
  | 'invalid_or_expired'
  | 'wrong_device'
  | 'account_inactive'
  | 'demo_expired'
  | 'rate_limited';

export type AuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Exclude<AuthFailure, 'rate_limited'> }
  | { ok: false; reason: 'rate_limited'; retryAfterSeconds: number };

export interface NewVerification {
  orgId: string;
  userId: string;
  method: VerificationMethod;
  credentialDigest: string;
  browserNonceDigest: string;
  expiresAt: Date;
}

export interface NewSession {
  orgId: string;
  userId: string;
  tokenDigest: string;
  expiresAt: Date;
  isDemo: boolean;
}

export interface DemoAccountInput {
  orgId: string;
  userId: string;
  codeDigest: string;
  expiresAt: Date;
}

export interface AuthStore {
  findUserByIdentifier(orgId: string, method: VerificationMethod, identifier: string): Promise<AuthUser | null>;
  createVerification(input: NewVerification): Promise<void>;
  consumeVerification(input: {
    orgId: string;
    method: VerificationMethod | undefined;
    credentialDigest: string;
    browserNonceDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>>;
  consumeDemoAccount(input: {
    orgId: string;
    codeDigest: string;
    now: Date;
  }): Promise<AuthResult<AuthUser>>;
  createDemoAccount(input: DemoAccountInput): Promise<void>;
  createSession(input: NewSession): Promise<void>;
  findSession(orgId: string, tokenDigest: string, now: Date): Promise<SessionRecord | null>;
  revokeSession(orgId: string, tokenDigest: string, now: Date): Promise<boolean>;
  incrementRateLimit(input: RateLimitIncrement): Promise<RateLimitDecision>;
}

export type RateLimitPurpose =
  | 'request_identifier'
  | 'request_ip'
  | 'verify_device'
  | 'verify_ip'
  | 'demo_device'
  | 'demo_ip';

export interface RateLimitIncrement {
  orgId: string;
  purpose: RateLimitPurpose;
  subjectDigest: string;
  now: Date;
  windowSeconds: number;
  limit: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  count: number;
}
