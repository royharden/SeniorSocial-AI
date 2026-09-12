import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { cookies } from 'next/headers';
import { loadConfig } from '@seniorsocial/config';
import { catalogs } from '@seniorsocial/i18n';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import './globals.css';

/**
 * Minimum root layout (WP-001 scaffold only).
 *
 * WP-007 owns the real shell: tokens, Easy Mode, the language toggle, the
 * standing "Call a person" route, and the i18n provider. Nothing of that belongs
 * here, and adding it would put two packages on the same file.
 */

export function generateMetadata(): Metadata {
  const { branding } = loadConfig();
  return {
    title: branding.appName,
    description: 'Community services for older adults.',
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { branding } = loadConfig();
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const text = catalogs[locale].shell;

  return (
    <html lang={locale}>
      <body>
        <a className="ss-skip-link" href="#main">{text.skip_main}</a>
        {children}
        <footer>{branding.appName}</footer>
      </body>
    </html>
  );
}
