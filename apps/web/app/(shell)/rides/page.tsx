import { randomUUID } from 'node:crypto';
import { resolveCatalogMessage, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { cookies } from 'next/headers';
import { RideRequestForm } from './ride-request-form';

type Locale = 'en' | 'es';

function message(locale: Locale, key: 'page.title' | 'page.disclaimer'): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'rides', key });
}

const headerAffordanceId = 'rides-header-catalog-affordance';

function CatalogText({ value }: { readonly value: CatalogResolution }) {
  return <span
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale ?? undefined}
  >{value.text}</span>;
}

export function RidesHeader({ title, disclaimer }: {
  readonly title: CatalogResolution;
  readonly disclaimer: CatalogResolution;
}) {
  const fallbackResolution = title.affordance !== null
    ? title
    : disclaimer.affordance !== null
      ? disclaimer
      : null;

  return <div>
    <h1
      aria-describedby={fallbackResolution === null ? undefined : headerAffordanceId}
      id="rides-heading"
    ><CatalogText value={title} /></h1>
    <p><CatalogText value={disclaimer} /></p>
    {fallbackResolution === null ? null : <p
      data-catalog-affordance={fallbackResolution.renderState}
      data-catalog-key={`${fallbackResolution.namespace}.${fallbackResolution.key}`}
      id={headerAffordanceId}
      lang="en"
    >{fallbackResolution.affordance}</p>}
  </div>;
}

export default async function RidesPage() {
  const stored = await cookies();
  const locale: Locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const title = message(locale, 'page.title');
  const disclaimer = message(locale, 'page.disclaimer');

  return (
    <section aria-labelledby="rides-heading" style={{ display: 'grid', gap: 'var(--ss-page-gap)' }}>
      <RidesHeader disclaimer={disclaimer} title={title} />
      <RideRequestForm idempotencyKey={randomUUID()} locale={locale} />
    </section>
  );
}
