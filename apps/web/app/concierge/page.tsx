import { cookies } from 'next/headers';
import { loadConfig } from '@seniorsocial/config';
import { AppShell, LOCALE_STORAGE_KEY, MODE_STORAGE_KEY } from '@seniorsocial/ui';
import { ConciergeClient } from './concierge-client';
import '@seniorsocial/ui/styles.css';

export default async function ConciergePage() {
  const { branding } = loadConfig();
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';

  return <AppShell appName={branding.appName} locale={locale} mode={mode}>
    <ConciergeClient locale={locale} />
  </AppShell>;
}
