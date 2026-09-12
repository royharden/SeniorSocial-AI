import { digestSecret, randomSixDigitCode, randomToken } from './crypto';
import type {
  AuthResult,
  AuthRole,
  AuthStore,
  DemoAccountInput,
  IssuedCredential,
  SessionRecord,
  VerificationMethod,
} from './types';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface AuthServiceOptions {
  pepper: string;
  now?: () => Date;
  exposeSimulationCredentials?: boolean;
}

export interface EstablishedSession extends SessionRecord {
  token: string;
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('auth rate limit exceeded');
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AuthService {
  readonly #store: AuthStore;
  readonly #pepper: string;
  readonly #now: () => Date;
  readonly #exposeSimulationCredentials: boolean;

  constructor(store: AuthStore, options: AuthServiceOptions) {
    if (options.pepper.length < 16) throw new Error('auth pepper must contain at least 16 characters');
    this.#store = store;
    this.#pepper = options.pepper;
    this.#now = options.now ?? (() => new Date());
    this.#exposeSimulationCredentials = options.exposeSimulationCredentials ?? false;
  }

  async requestMagicLink(orgId: string, email: string, browserNonce: string, requestIp = 'local'): Promise<IssuedCredential> {
    return this.#requestCredential(orgId, 'magic_link', email.trim().toLowerCase(), browserNonce, requestIp);
  }

  async requestSmsCode(orgId: string, phone: string, browserNonce: string, requestIp = 'local'): Promise<IssuedCredential> {
    return this.#requestCredential(orgId, 'sms_code', phone.trim(), browserNonce, requestIp);
  }

  async #requestCredential(
    orgId: string,
    method: VerificationMethod,
    identifier: string,
    browserNonce: string,
    requestIp: string,
  ): Promise<IssuedCredential> {
    const now = this.#now();
    await this.#enforceRateLimit(orgId, 'request_identifier', identifier, now, 15 * 60, 3);
    await this.#enforceRateLimit(orgId, 'request_ip', requestIp, now, 15 * 60, 30);
    const user = await this.#store.findUserByIdentifier(orgId, method, identifier);
    const credential = method === 'sms_code' ? randomSixDigitCode() : randomToken();
    if (user?.accountState === 'active') {
      await this.#store.createVerification({
        orgId,
        userId: user.id,
        method,
        credentialDigest: digestSecret(credential, this.#pepper),
        browserNonceDigest: digestSecret(browserNonce, this.#pepper),
        expiresAt: new Date(now.getTime() + (method === 'sms_code' ? 10 : 15) * MINUTE),
      });
    }
    return this.#exposeSimulationCredentials
      ? { accepted: true, simulationCredential: credential }
      : { accepted: true };
  }

  async verify(
    orgId: string,
    method: VerificationMethod | undefined,
    credential: string,
    browserNonce: string,
    requestIp = 'local',
  ): Promise<AuthResult<EstablishedSession>> {
    const now = this.#now();
    try {
      await this.#enforceRateLimit(orgId, 'verify_device', browserNonce, now, 60 * 60, 10);
      await this.#enforceRateLimit(orgId, 'verify_ip', requestIp, now, 60 * 60, 30);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return { ok: false, reason: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
      }
      throw error;
    }
    const result = await this.#store.consumeVerification({
      orgId,
      method,
      credentialDigest: digestSecret(credential, this.#pepper),
      browserNonceDigest: digestSecret(browserNonce, this.#pepper),
      now,
    });
    if (!result.ok) return result;
    return { ok: true, value: await this.#establishSession(result.value.id, orgId, result.value.roles, false) };
  }

  async loginWithDemoCode(
    orgId: string,
    code: string,
    browserNonce = 'local',
    requestIp = 'local',
  ): Promise<AuthResult<EstablishedSession>> {
    const now = this.#now();
    try {
      await this.#enforceRateLimit(orgId, 'demo_device', browserNonce, now, 15 * 60, 5);
      await this.#enforceRateLimit(orgId, 'demo_ip', requestIp, now, 15 * 60, 20);
    } catch (error) {
      if (error instanceof RateLimitError) {
        return { ok: false, reason: 'rate_limited', retryAfterSeconds: error.retryAfterSeconds };
      }
      throw error;
    }
    const result = await this.#store.consumeDemoAccount({
      orgId,
      codeDigest: digestSecret(code, this.#pepper),
      now,
    });
    if (!result.ok) return result;
    return { ok: true, value: await this.#establishSession(result.value.id, orgId, result.value.roles, true) };
  }

  async bootstrapDemoAccount(input: Omit<DemoAccountInput, 'codeDigest'> & { code: string }): Promise<void> {
    await this.#store.createDemoAccount({
      orgId: input.orgId,
      userId: input.userId,
      expiresAt: input.expiresAt,
      codeDigest: digestSecret(input.code, this.#pepper),
    });
  }

  async #establishSession(
    userId: string,
    orgId: string,
    roles: AuthRole[],
    isDemo: boolean,
  ): Promise<EstablishedSession> {
    const token = randomToken();
    const expiresAt = new Date(this.#now().getTime() + (isDemo ? 12 * 60 * MINUTE : 30 * DAY));
    await this.#store.createSession({
      orgId,
      userId,
      tokenDigest: digestSecret(token, this.#pepper),
      expiresAt,
      isDemo,
    });
    return { token, userId, orgId, roles, expiresAt, isDemo };
  }

  session(orgId: string, token: string): Promise<SessionRecord | null> {
    return this.#store.findSession(orgId, digestSecret(token, this.#pepper), this.#now());
  }

  logout(orgId: string, token: string): Promise<boolean> {
    return this.#store.revokeSession(orgId, digestSecret(token, this.#pepper), this.#now());
  }

  async #enforceRateLimit(
    orgId: string,
    purpose: 'request_identifier' | 'request_ip' | 'verify_device' | 'verify_ip' | 'demo_device' | 'demo_ip',
    subject: string,
    now: Date,
    windowSeconds: number,
    limit: number,
  ): Promise<void> {
    const decision = await this.#store.incrementRateLimit({
      orgId,
      purpose,
      subjectDigest: digestSecret(subject, this.#pepper),
      now,
      windowSeconds,
      limit,
    });
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  }
}
