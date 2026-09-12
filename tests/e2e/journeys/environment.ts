export const ORG_ID = '53000000-0000-4000-8000-000000000030';
export const RESIDENT_ID = '53000000-0000-4000-8000-000000000031';
export const STAFF_ID = '53000000-0000-4000-8000-000000000033';
export const OTHER_RESIDENT_ID = '53000000-0000-4000-8000-000000000034';
export const ADMIN_ID = '53000000-0000-4000-8000-000000000035';
export const FOREIGN_ORG_ID = '53000000-0000-4000-9000-000000000030';
export const FOREIGN_RESIDENT_ID = '53000000-0000-4000-9000-000000000031';
export const FOREIGN_STAFF_ID = '53000000-0000-4000-9000-000000000033';
export const PEPPER = 'wp030-synthetic-session-pepper';
export const RESIDENT_TOKEN = 'wp030-resident-session-token';
export const STAFF_TOKEN = 'wp030-staff-session-token';
export const ADMIN_TOKEN = 'wp030-admin-session-token';
export const FOREIGN_RESIDENT_TOKEN = 'wp030-foreign-resident-session-token';
export const ENCRYPTION_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
export const WEB_URL = 'http://localhost:3130';

export type Locale = 'en' | 'es';
export type DisplayMode = 'standard' | 'easy';
export const matrix = [
  { locale: 'en', mode: 'standard' },
  { locale: 'en', mode: 'easy' },
  { locale: 'es', mode: 'standard' },
  { locale: 'es', mode: 'easy' },
] as const satisfies readonly { locale: Locale; mode: DisplayMode }[];

export function journeyEnvironment() {
  if (process.env.WP030_E2E_ALLOWED !== 'true') throw new Error('WP030_E2E_ALLOWED=true is required; journey tests never skip');
  if (process.env.WP030_E2E_DISPOSABLE_CLUSTER !== 'true') throw new Error('WP030_E2E_DISPOSABLE_CLUSTER=true is required because migrations may create cluster-global roles');
  const ownerValue = process.env.WP030_E2E_OWNER_DATABASE_URL;
  if (!ownerValue) throw new Error('WP030_E2E_OWNER_DATABASE_URL is required; journey tests never skip');
  const runId = process.env.WP030_E2E_RUN_ID;
  if (!runId || !/^[a-z0-9]{4,16}$/u.test(runId)) throw new Error('WP030_E2E_RUN_ID must be 4-16 lowercase letters or digits');
  const ownerUrl = new URL(ownerValue);
  if (!['postgres:', 'postgresql:'].includes(ownerUrl.protocol) || !['localhost', '127.0.0.1'].includes(ownerUrl.hostname) || ownerUrl.pathname !== '/postgres') {
    throw new Error('WP-030 owner URL must target the local PostgreSQL maintenance database');
  }
  const databaseName = `ss_wp030_e2e_${runId}`;
  const runtimeRole = `ss_wp030_rt_${runId}`;
  const runtimePassword = `WP030-${runId}-runtime`;
  const databaseUrl = new URL(ownerUrl); databaseUrl.pathname = `/${databaseName}`;
  const runtimeUrl = new URL(databaseUrl); runtimeUrl.username = runtimeRole; runtimeUrl.password = runtimePassword;
  return { ownerUrl: ownerUrl.toString(), databaseUrl: databaseUrl.toString(), runtimeUrl: runtimeUrl.toString(), databaseName, runtimeRole, runtimePassword };
}

export function eventId(index: number, full: boolean): string {
  return `53000000-0000-4000-8${full ? '2' : '1'}00-${String(100 + index).padStart(12, '0')}`;
}

export function linkId(index: number): string {
  return `53000000-0000-4000-8300-${String(100 + index).padStart(12, '0')}`;
}

export function caregiverId(index: number): string {
  return `53000000-0000-4000-8600-${String(100 + index).padStart(12, '0')}`;
}

export function caregiverToken(index: number): string {
  return `wp030-caregiver-${index}-session-token`;
}
