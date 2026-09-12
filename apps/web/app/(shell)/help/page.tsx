import { cookies } from 'next/headers';
import {
  resolveCatalogMessage, type CatalogKey, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { AssistanceForm } from './assistance-form';

type Locale = 'en' | 'es';
type AssistanceKey = CatalogKey<'assistance'>;
type ShellKey = CatalogKey<'shell'>;

const helpAssistanceKeys = [
  'emergency.heading', 'emergency.disclaimer', 'emergency.call_911',
] as const satisfies readonly AssistanceKey[];
const helpShellKeys = ['help_heading', 'help_body', 'return_home'] as const satisfies readonly ShellKey[];

type AffordanceGroup = {
  readonly notices: readonly {
    readonly id: string;
    readonly keys: readonly string[];
    readonly renderState: string;
    readonly text: string;
  }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function assistanceMessage(locale: Locale, key: CatalogMessageRequest<'assistance'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'assistance', key });
}

function shellMessage(locale: Locale, key: CatalogMessageRequest<'shell'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'shell', key });
}

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

export function HelpContent({ locale }: { readonly locale: Locale }) {
  const assistance = Object.fromEntries(helpAssistanceKeys.map(key => [key, assistanceMessage(locale, key)])) as
    Record<(typeof helpAssistanceKeys)[number], CatalogResolution>;
  const shell = Object.fromEntries(helpShellKeys.map(key => [key, shellMessage(locale, key)])) as
    Record<(typeof helpShellKeys)[number], CatalogResolution>;
  const affordances = createAffordanceGroup('help-i18n-notice', [
    ...helpAssistanceKeys.map(key => assistance[key]),
    ...helpShellKeys.map(key => shell[key]),
  ]);

  return (
    <>
      <section aria-labelledby="emergency-heading" className="ss-card" role="alert">
        <h1 id="emergency-heading"><CatalogText group={affordances} value={assistance['emergency.heading']} /></h1>
        <p><CatalogText group={affordances} value={assistance['emergency.disclaimer']} /></p>
        <a aria-describedby={affordances.describedBy(assistance['emergency.call_911'])} href="tel:911">
          <CatalogText described={false} group={affordances} value={assistance['emergency.call_911']} />
        </a>
      </section>
      <section aria-labelledby="help-heading" className="ss-card">
        <h2 id="help-heading"><CatalogText group={affordances} value={shell.help_heading} /></h2>
        <p><CatalogText group={affordances} value={shell.help_body} /></p>
      </section>
      <AssistanceForm locale={locale} />
      <a aria-describedby={affordances.describedBy(shell.return_home)} href="/home">
        <CatalogText described={false} group={affordances} value={shell.return_home} />
      </a>
      <AffordanceNotices group={affordances} />
    </>
  );
}

export default async function HelpPage() {
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <HelpContent locale={locale} />;
}
