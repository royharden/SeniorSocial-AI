import { cookies } from 'next/headers';
import {
  resolveCatalogMessage, type CatalogKey, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';

type Locale = 'en' | 'es';
type ShellKey = CatalogKey<'shell'>;

const homeKeys = [
  'home_heading', 'home_intro', 'service_heading', 'service_body', 'service_link',
  'events_heading', 'events_body', 'events_link',
] as const satisfies readonly ShellKey[];

type AffordanceGroup = {
  readonly notices: readonly {
    readonly id: string;
    readonly keys: readonly string[];
    readonly renderState: string;
    readonly text: string;
  }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const unique = new Map<string, { keys: string[]; renderState: string; text: string }>();
  for (const value of values) {
    if (!value.found || value.affordance === null) continue;
    const groupKey = `${value.renderState}\u0000${value.affordance}`;
    const catalogKey = `${value.namespace}.${value.key}`;
    const existing = unique.get(groupKey);
    if (existing) existing.keys.push(catalogKey);
    else unique.set(groupKey, { keys: [catalogKey], renderState: value.renderState, text: value.affordance });
  }
  const notices = [...unique.values()].map((value, index) => ({
    id: `${prefix}-${index + 1}`,
    ...value,
  }));
  return {
    notices,
    describedBy(value) {
      if (!value.found || value.affordance === null) return undefined;
      return notices.find(notice => (
        notice.renderState === value.renderState && notice.text === value.affordance
      ))?.id;
    },
  };
}

function CatalogText({ described = true, group, value }: {
  readonly described?: boolean;
  readonly group: AffordanceGroup;
  readonly value: CatalogResolution;
}) {
  if (!value.found) return null;
  return <span
    aria-describedby={described ? group.describedBy(value) : undefined}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    data-catalog-review-status={value.reviewStatus}
    lang={value.renderedLocale}
  >{value.text}</span>;
}

function AffordanceNotices({ group }: { readonly group: AffordanceGroup }) {
  if (group.notices.length === 0) return null;
  return <div data-catalog-affordance-group>
    {group.notices.map(notice => <small
      data-catalog-affordance={notice.renderState}
      data-catalog-keys={notice.keys.join(' ')}
      id={notice.id}
      key={notice.id}
      lang="en"
      role="note"
    >{notice.text}</small>)}
  </div>;
}

export function HomeContent({ locale }: { readonly locale: Locale }) {
  const text = Object.fromEntries(homeKeys.map(key => [
    key, resolveCatalogMessage({ locale, namespace: 'shell', key }),
  ])) as Record<(typeof homeKeys)[number], CatalogResolution>;
  const affordances = createAffordanceGroup('home-i18n-notice', homeKeys.map(key => text[key]));

  return (
    <section aria-labelledby="home-heading">
      <h1 id="home-heading"><CatalogText group={affordances} value={text.home_heading} /></h1>
      <p><CatalogText group={affordances} value={text.home_intro} /></p>
      <div className="ss-card-grid">
        <article className="ss-card">
          <h2><CatalogText group={affordances} value={text.service_heading} /></h2>
          <p><CatalogText group={affordances} value={text.service_body} /></p>
          <a aria-describedby={affordances.describedBy(text.service_link)} href="/services">
            <CatalogText described={false} group={affordances} value={text.service_link} />
          </a>
        </article>
        <article className="ss-card">
          <h2><CatalogText group={affordances} value={text.events_heading} /></h2>
          <p><CatalogText group={affordances} value={text.events_body} /></p>
          <a aria-describedby={affordances.describedBy(text.events_link)} href="/events">
            <CatalogText described={false} group={affordances} value={text.events_link} />
          </a>
        </article>
      </div>
      <AffordanceNotices group={affordances} />
    </section>
  );
}

export default async function HomePage() {
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <HomeContent locale={locale} />;
}
