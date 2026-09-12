/**
 * @seniorsocial/config — the one place environment is read (WP-001).
 *
 * Two rules this module exists to make mechanical:
 *
 *   C5 — branding, city name, contacts and demo accounts come from env or admin
 *        data. NEVER hard-code a customer. Every default here is generic, and a
 *        deployment that wants a city name sets one.
 *   SEC-064 — real SMS is disabled BY CONFIGURATION. `smsProvider` defaults to
 *        `simulator` and `isLiveMessagingEnabled` is the single predicate the
 *        rest of the product asks. An empty credential is a second line of
 *        defence, never the control.
 *
 * There is deliberately no voice provider here (ADR-009, docket DK-007): voice
 * reminders are cut at rank 1 for this run, so there is no adapter to configure
 * and no switch to turn off. SEC-064's voice half is satisfied by the cut. Adding
 * a VOICE_PROVIDER key back would encode a switch for something this run does not
 * ship, which is worse than absent because it reads as a control that works.
 *
 * WP-007 owns tokens, theme and i18n; this module holds none of them.
 */

export type AiProvider = 'stub' | 'anthropic-api' | 'claude-cli-bridge';
export type SmsProvider = 'simulator' | 'twilio';
export type EmailProvider = 'mailpit' | 'smtp';
export type DatabaseSslMode = 'disable' | 'require';

export interface BrandingConfig {
  readonly appName: string;
  readonly cityName: string | null;
  readonly cityTimezone: string;
  readonly supportPhone: string | null;
  readonly logoUrl: string | null;
  readonly primaryColor: string;
}

export interface MessagingConfig {
  readonly smsProvider: SmsProvider;
  readonly emailProvider: EmailProvider;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly aiProvider: AiProvider;
  readonly databaseSsl: DatabaseSslMode;
  readonly enableHsts: boolean;
  readonly branding: BrandingConfig;
  readonly messaging: MessagingConfig;
}

type Env = Record<string, string | undefined>;

function str(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v.trim() === '' ? fallback : v.trim();
}

function nullable(env: Env, key: string): string | null {
  const v = env[key];
  return v === undefined || v.trim() === '' ? null : v.trim();
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v.trim() === '') return fallback;
  return v.trim().toLowerCase() === 'true';
}

function oneOf<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = env[key]?.trim();
  if (v === undefined || v === '') return fallback;
  const match = allowed.find((a) => a === v);
  if (match === undefined) {
    throw new Error(
      `${key}="${v}" is not one of ${allowed.join(' | ')}. ` +
      'Configuration fails loudly rather than falling back to a default that hides the typo.'
    );
  }
  return match;
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    nodeEnv: oneOf(env, 'NODE_ENV', ['development', 'test', 'production'] as const, 'development'),
    aiProvider: oneOf(env, 'AI_PROVIDER', ['stub', 'anthropic-api', 'claude-cli-bridge'] as const, 'stub'),
    databaseSsl: oneOf(env, 'DATABASE_SSL', ['disable', 'require'] as const, 'disable'),
    enableHsts: bool(env, 'ENABLE_HSTS', false),
    branding: {
      appName: str(env, 'APP_NAME', 'SeniorSocial'),
      cityName: nullable(env, 'CITY_NAME'),
      cityTimezone: str(env, 'CITY_TIMEZONE', 'America/New_York'),
      supportPhone: nullable(env, 'SUPPORT_PHONE'),
      logoUrl: nullable(env, 'LOGO_URL'),
      primaryColor: str(env, 'PRIMARY_COLOR', '#155E8F'),
    },
    messaging: {
      smsProvider: oneOf(env, 'SMS_PROVIDER', ['simulator', 'twilio'] as const, 'simulator'),
      emailProvider: oneOf(env, 'EMAIL_PROVIDER', ['mailpit', 'smtp'] as const, 'mailpit'),
    },
  };
}

/**
 * SEC-064. The single predicate the product asks before anything can reach a real
 * handset. Voice is not part of it because voice is cut for this run (ADR-009);
 * if a later docket un-cuts it, this predicate is where the new provider joins,
 * so there is exactly one place to change.
 */
export function isLiveMessagingEnabled(config: AppConfig): boolean {
  return config.messaging.smsProvider === 'twilio';
}
