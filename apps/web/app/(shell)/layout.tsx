import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { loadConfig } from '@seniorsocial/config';
import { AppShell, LOCALE_STORAGE_KEY, MODE_STORAGE_KEY } from '@seniorsocial/ui';
import '@seniorsocial/ui/styles.css';

export default async function ShellLayout({ children }: { readonly children: ReactNode }) {
  const { branding } = loadConfig();
  const stored = await cookies();
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <AppShell appName={branding.appName} locale={locale} mode={mode}>{children}</AppShell>;
}
