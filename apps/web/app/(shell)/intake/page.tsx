import { cookies } from 'next/headers';
import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import styles from './intake.module.css';

type Locale = 'en' | 'es';
type IntakeKey = CatalogMessageRequest<'intake'>['key'];
export type IntakeMessageResolver = (input: CatalogMessageRequest<'intake'>) => CatalogResolution;

function messageId(value: CatalogResolution): string {
  return `intake-${value.key.replaceAll('.', '-')}-translation-state`;
}

function CatalogText({ value }: { readonly value: CatalogResolution }) {
  if (!value.found) return null;
  return <span
    aria-describedby={value.affordance === null ? undefined : messageId(value)}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale}
  >{value.text}</span>;
}

function CatalogAffordance({ value }: { readonly value: CatalogResolution }) {
  if (!value.found || value.affordance === null) return null;
  return <p
    data-catalog-affordance={value.renderState}
    id={messageId(value)}
    lang="en"
    role="note"
  >{value.affordance}</p>;
}

function IntakeLanding({ locale, resolveMessage = resolveCatalogMessage }: {
  readonly locale: Locale;
  readonly resolveMessage?: IntakeMessageResolver;
}) {
  const message = (key: IntakeKey) => resolveMessage({ locale, namespace: 'intake', key });
  const title = message('landing.title');
  const intro = message('landing.intro');
  const legalHeading = message('landing.legal_heading');
  const legalDescription = message('landing.legal_description');
  const legalStart = message('landing.legal_start');
  const healthHeading = message('landing.health_heading');
  const healthDescription = message('landing.health_description');
  const healthStart = message('landing.health_start');
  const healthDisclaimer = message('disclaimer.health');

  return (
    <section aria-labelledby="intake-heading" className={styles.stack}>
      <div>
        <h1 id="intake-heading"><CatalogText value={title} /></h1>
        <CatalogAffordance value={title} />
        <p><CatalogText value={intro} /></p>
        <CatalogAffordance value={intro} />
      </div>
      <div className={styles.choiceGrid}>
        <article className="ss-card">
          <h2><CatalogText value={legalHeading} /></h2>
          <CatalogAffordance value={legalHeading} />
          <p><CatalogText value={legalDescription} /></p>
          <CatalogAffordance value={legalDescription} />
          <a className={styles.primaryLink} href="/intake/legal"><CatalogText value={legalStart} /></a>
          <CatalogAffordance value={legalStart} />
        </article>
        <article className="ss-card">
          <h2><CatalogText value={healthHeading} /></h2>
          <CatalogAffordance value={healthHeading} />
          <p><CatalogText value={healthDescription} /></p>
          <CatalogAffordance value={healthDescription} />
          <p data-intake-health-disclaimer><CatalogText value={healthDisclaimer} /></p>
          <CatalogAffordance value={healthDisclaimer} />
          <a className={styles.primaryLink} href="/intake/health"><CatalogText value={healthStart} /></a>
          <CatalogAffordance value={healthStart} />
        </article>
      </div>
    </section>
  );
}

export default async function IntakePage() {
  const stored = await cookies();
  const locale: Locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <IntakeLanding locale={locale} />;
}
