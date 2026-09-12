import { cookies } from 'next/headers';
import { loadConfig } from '@seniorsocial/config';
import { resolveCatalogMessage, type CatalogKey, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import { AppShell, LOCALE_STORAGE_KEY, MODE_STORAGE_KEY, type SupportedLocale } from '@seniorsocial/ui';
import '@seniorsocial/ui/styles.css';

function shellMessage(locale: SupportedLocale, key: CatalogKey<'shell'>): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'shell', key });
}

const publicHomeAffordanceId = 'public-home-catalog-affordance';

function Message({ value }: { readonly value: CatalogResolution }) {
  if (!value.found) return null;
  return <span
    aria-describedby={value.affordance ? publicHomeAffordanceId : undefined}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    data-catalog-review-status={value.reviewStatus}
    lang={value.renderedLocale}
  >{value.text}</span>;
}

export default async function HomePage() {
  const { branding } = loadConfig();
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';
  const heading = shellMessage(locale, 'home_heading');
  const intro = shellMessage(locale, 'home_intro');
  const serviceHeading = shellMessage(locale, 'service_heading');
  const serviceBody = shellMessage(locale, 'service_body');
  const serviceLink = shellMessage(locale, 'service_link');
  const eventsHeading = shellMessage(locale, 'events_heading');
  const eventsBody = shellMessage(locale, 'events_body');
  const eventsLink = shellMessage(locale, 'events_link');
  const helpHeading = shellMessage(locale, 'help_heading');
  const helpBody = shellMessage(locale, 'help_body');
  const helpLink = shellMessage(locale, 'help_me');

  return <AppShell appName={branding.appName} locale={locale} mode={mode}>
    <section aria-labelledby="public-home-heading">
      <h1 id="public-home-heading"><Message value={heading} /></h1>
      <p><Message value={intro} /></p>
      {heading.found && heading.affordance ? <p data-catalog-affordance={heading.renderState} id={publicHomeAffordanceId} lang="en" role="note">{heading.affordance}</p> : null}
      <div className="ss-card-grid">
        <article className="ss-card"><h2><Message value={serviceHeading} /></h2><p><Message value={serviceBody} /></p><a href="/services"><Message value={serviceLink} /></a></article>
        <article className="ss-card"><h2><Message value={eventsHeading} /></h2><p><Message value={eventsBody} /></p><a href="/events"><Message value={eventsLink} /></a></article>
        <article className="ss-card"><h2><Message value={helpHeading} /></h2><p><Message value={helpBody} /></p><a href="/help"><Message value={helpLink} /></a></article>
      </div>
    </section>
  </AppShell>;
}
