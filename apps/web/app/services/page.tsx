import { cookies } from 'next/headers';
import { loadConfig } from '@seniorsocial/config';
import { resolveCatalogMessage, type CatalogKey, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import { AppShell, LOCALE_STORAGE_KEY, MODE_STORAGE_KEY, type SupportedLocale } from '@seniorsocial/ui';
import { publicServiceContext } from '../api/v1/services/_context';
import { servicesRepository } from '../api/v1/services/_runtime';
import styles from './services.module.css';
import '@seniorsocial/ui/styles.css';

function serviceMessage(locale: SupportedLocale, key: CatalogKey<'services'>): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'services', key });
}

function Message({ value }: { readonly value: CatalogResolution }) {
  if (!value.found) return null;
  return <span data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    lang={value.renderedLocale}>{value.text}</span>;
}

function noticeId(value:CatalogResolution,instance?:string|number):string {
  const suffix=instance===undefined?'':`-${String(instance).replaceAll(/[^A-Za-z0-9_-]/gu,'-')}`;
  return `services-${value.key.replaceAll('.','-')}${suffix}-translation-state`;
}

function describedBy(value:CatalogResolution,instance?:string|number):string|undefined {
  return value.affordance ? noticeId(value,instance) : undefined;
}

function descriptions(...ids:Array<string|undefined>):string|undefined {
  const tokens=ids.filter((id):id is string=>id!==undefined);
  return tokens.length>0?tokens.join(' '):undefined;
}

function Affordance({value,instance}:{readonly value:CatalogResolution;readonly instance?:string|number}) {
  if(!value.found||!value.affordance)return null;
  return <small data-catalog-affordance={value.renderState} data-catalog-key={`${value.namespace}.${value.key}`}
    id={noticeId(value,instance)} lang="en" role="note">{value.affordance}</small>;
}

function interpolate(value: CatalogResolution, token: string, replacement: string): CatalogResolution {
  return value.found ? { ...value, text: value.text.replace(`{${token}}`, replacement) } : value;
}

export default async function ServicesPage({ searchParams }: { readonly searchParams: Promise<{ q?: string }> }) {
  const { branding } = loadConfig();
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';
  const heading = serviceMessage(locale, 'directory.heading');
  const intro = serviceMessage(locale, 'directory.intro');
  const searchLabel = serviceMessage(locale, 'directory.search_label');
  const searchPlaceholder = serviceMessage(locale, 'directory.search_placeholder');
  const searchAction = serviceMessage(locale, 'directory.search_action');
  const noResults = serviceMessage(locale, 'directory.no_results');
  const error = serviceMessage(locale, 'directory.error');
  const eligibility = serviceMessage(locale, 'directory.eligibility');
  const sourceUpdated = serviceMessage(locale, 'directory.source_updated');
  const query = (await searchParams).q?.trim();
  let items: Awaited<ReturnType<ReturnType<typeof servicesRepository>['search']>>['items'] = [];
  let unavailable = false;
  if (query !== undefined) {
    try {
      const context = publicServiceContext();
      items = (await servicesRepository().search(context.orgId, { query, locale, limit: 20 })).items;
    } catch {
      unavailable = true;
    }
  }

  return <AppShell appName={branding.appName} locale={locale} mode={mode}>
    <section aria-labelledby="services-heading">
      <h1 aria-describedby={describedBy(heading)} id="services-heading"><Message value={heading} /></h1>
      <Affordance value={heading} />
      <p aria-describedby={describedBy(intro)}><Message value={intro} /></p>
      <Affordance value={intro} />
      <form action="/services" className={`ss-card ${styles.search}`} method="get" role="search">
        <label aria-describedby={describedBy(searchLabel)} htmlFor="service-query"><strong><Message value={searchLabel} /></strong></label>
        <Affordance value={searchLabel} />
        <input aria-describedby={descriptions(describedBy(searchLabel),describedBy(searchPlaceholder))}
          aria-label={searchLabel.text} className={styles.input} data-catalog-fallback-reason={searchPlaceholder.fallbackReason ?? undefined}
          data-catalog-key={`${searchPlaceholder.namespace}.${searchPlaceholder.key}`} data-catalog-render-state={searchPlaceholder.renderState}
          defaultValue={query} id="service-query" lang={searchPlaceholder.renderedLocale ?? undefined} name="q" placeholder={searchPlaceholder.text} type="search" />
        <Affordance value={searchPlaceholder} />
        <button aria-describedby={describedBy(searchAction)} className="ss-primary-action"
          data-catalog-fallback-reason={searchAction.fallbackReason ?? undefined} data-catalog-key={`${searchAction.namespace}.${searchAction.key}`}
          data-catalog-render-state={searchAction.renderState} lang={searchAction.renderedLocale ?? undefined} type="submit">{searchAction.text}</button>
        <Affordance value={searchAction} />
      </form>
      <div aria-live="polite" aria-relevant="additions text">
        {unavailable ? <><p aria-describedby={describedBy(error)} role="alert"><Message value={error} /></p><Affordance value={error} /></> : null}
        {query !== undefined && !unavailable && items.length === 0 ? <><p aria-describedby={describedBy(noResults)}><Message value={noResults} /></p><Affordance value={noResults} /></> : null}
        {items.map((item,index) => {const eligibilityValue=interpolate(eligibility,'summary',item.eligibility_note??'');const sourceValue=interpolate(sourceUpdated,'date',item.source_updated_at.slice(0,10));return <article className={`ss-card ${styles.result}`} key={item.id}>
          <h2>{item.name}</h2>
          <p>{item.description}</p>
          {item.eligibility_note ? <><p aria-describedby={describedBy(eligibilityValue,index)}><Message value={eligibilityValue} /></p><Affordance instance={index} value={eligibilityValue} /></> : null}
          {item.phone ? <a href={`tel:${item.phone}`}>{item.phone}</a> : null}
          <p aria-describedby={describedBy(sourceValue,index)}><Message value={sourceValue} /></p><Affordance instance={index} value={sourceValue} />
        </article>;})}
      </div>
    </section>
  </AppShell>;
}
