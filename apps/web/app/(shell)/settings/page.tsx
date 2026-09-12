import { cookies } from 'next/headers';
import {
  resolveCatalogMessage, type CatalogKey, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import Link from 'next/link';
import { LOCALE_STORAGE_KEY, MODE_STORAGE_KEY, PreferenceSettings } from '@seniorsocial/ui';

type Locale = 'en' | 'es';
type Resolver = (request: { locale: Locale; namespace: 'profile'; key: CatalogKey<'profile'> }) => CatalogResolution;

function CatalogMessage({ value }: { readonly value: CatalogResolution }) {
  return <span data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    lang={value.renderedLocale ?? undefined}>{value.text}</span>;
}

function Notice({ id, value }: { readonly id: string; readonly value: CatalogResolution }) {
  return value.affordance ? <small data-catalog-affordance={value.renderState} id={id} lang="en">{value.affordance}</small> : null;
}

export function SettingsContent({ locale, mode, resolveMessage = resolveCatalogMessage }: {
  readonly locale: Locale; readonly mode: 'standard' | 'easy'; readonly resolveMessage?: Resolver;
}) {
  const heading = resolveMessage({ locale, namespace: 'profile', key: 'settings_heading' });
  const dataHeading = resolveMessage({ locale, namespace: 'profile', key: 'data_heading' });
  const dataIntro = resolveMessage({ locale, namespace: 'profile', key: 'data_export_intro' });
  const dataLink = resolveMessage({ locale, namespace: 'profile', key: 'data_export_link' });
  return <section aria-labelledby="settings-heading">
    <h1 aria-describedby={heading.affordance ? 'settings-heading-translation' : undefined} id="settings-heading"><CatalogMessage value={heading} /></h1>
    <Notice id="settings-heading-translation" value={heading} />
    <PreferenceSettings locale={locale} mode={mode} resolveMessage={resolveMessage} />
    <section aria-labelledby="settings-data-heading" className="ss-card">
      <h2 aria-describedby={dataHeading.affordance ? 'settings-data-heading-translation' : undefined} id="settings-data-heading"><CatalogMessage value={dataHeading} /></h2>
      <Notice id="settings-data-heading-translation" value={dataHeading} />
      <p aria-describedby={dataIntro.affordance ? 'settings-data-intro-translation' : undefined}><CatalogMessage value={dataIntro} /></p>
      <Notice id="settings-data-intro-translation" value={dataIntro} />
      <Link aria-describedby={dataLink.affordance ? 'settings-data-link-translation' : undefined} href="/settings/data-export">
        <span data-catalog-key={`${dataLink.namespace}.${dataLink.key}`} data-catalog-render-state={dataLink.renderState}
          lang={dataLink.renderedLocale ?? undefined}>{dataLink.text}</span>
      </Link>
      {dataLink.affordance ? <small data-catalog-affordance={dataLink.renderState} id="settings-data-link-translation" lang="en">{dataLink.affordance}</small> : null}
    </section>
  </section>;
}

export default async function SettingsPage() {
  const stored = await cookies();
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <SettingsContent locale={locale} mode={mode} />;
}
