'use client';
import { useEffect, useId, useState } from 'react';
import { resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import type { PrintableSchedule } from '../../../../../packages/contracts/src/types';
import './print.css';

type Locale = 'en' | 'es';
type NotifyKey = CatalogMessageRequest<'notify'>['key'];

function message(locale: Locale, key: NotifyKey): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'notify', key });
}

type AffordanceGroup = {
  readonly notices: readonly {
    readonly fallbackReason: CatalogResolution['fallbackReason']; readonly id: string;
    readonly keys: readonly string[]; readonly renderState: CatalogResolution['renderState']; readonly text: string;
  }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function noticeIdentity(value: CatalogResolution): string | null {
  if (!value.found || value.affordance === null) return null;
  return JSON.stringify([value.affordance, value.renderState, value.fallbackReason]);
}

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const unique = new Map<string, {
    fallbackReason: CatalogResolution['fallbackReason']; keys: string[];
    renderState: CatalogResolution['renderState']; text: string;
  }>();
  for (const value of values) {
    const identity = noticeIdentity(value);
    if (identity === null || !value.found || value.affordance === null) continue;
    const catalogKey = `${value.namespace}.${value.key}`;
    const existing = unique.get(identity);
    if (existing) {
      if (!existing.keys.includes(catalogKey)) existing.keys.push(catalogKey);
    } else {
      unique.set(identity, {
        fallbackReason: value.fallbackReason, keys: [catalogKey],
        renderState: value.renderState, text: value.affordance,
      });
    }
  }
  const notices = [...unique.values()].map((notice, index) => ({ ...notice, id: `${prefix}-${index + 1}` }));
  return {
    notices,
    describedBy(value) {
      const identity = noticeIdentity(value);
      if (identity === null) return undefined;
      const index = [...unique.keys()].indexOf(identity);
      return index < 0 ? undefined : notices[index]?.id;
    },
  };
}

function CatalogText({ group, value, replacements = {} }: {
  readonly group: AffordanceGroup;
  readonly value: CatalogResolution;
  readonly replacements?: Readonly<Record<string, string>>;
}) {
  if (!value.found) return null;
  const text = Object.entries(replacements).reduce((result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement), value.text);
  return <span aria-describedby={group.describedBy(value)} data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    data-catalog-review-status={value.reviewStatus} data-render-state={value.renderState}
    data-review-status={value.reviewStatus} lang={value.renderedLocale ?? undefined}>{text}</span>;
}

function AffordanceNotices({ group }: { readonly group: AffordanceGroup }) {
  if (group.notices.length === 0) return null;
  return <div data-catalog-affordance-group>
    {group.notices.map(notice => <small data-catalog-affordance={notice.renderState}
      data-catalog-fallback-reason={notice.fallbackReason ?? undefined} data-catalog-keys={notice.keys.join(' ')}
      id={notice.id} key={notice.id} lang="en" role="note">{notice.text}</small>)}
  </div>;
}

export default function PrintSchedulePage() {
  const instanceId = useId().replaceAll(':', '');
  const [locale, setLocale] = useState<Locale>('en');
  const [localeReady, setLocaleReady] = useState(false);
  const [snapshot, setSnapshot] = useState<PrintableSchedule | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setLocale(document.querySelector<HTMLElement>('.ss-app')?.dataset.locale === 'es' ? 'es' : 'en');
    setLocaleReady(true);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/me/schedule/print', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      setSnapshot(await response.json() as PrintableSchedule); setUnavailable(false);
    }).catch(() => { if (!controller.signal.aborted) setUnavailable(true); });
    return () => controller.abort();
  }, []);
  const title = message(locale, 'print.title');
  const sourceUnavailable = unavailable ? message(locale, 'print.source_unavailable') : null;
  const sourceVersion = message(locale, 'print.source_version');
  const asOf = message(locale, 'print.as_of');
  const noSource = snapshot?.source_version.startsWith('schedule:no-connected-sources:') === true
    ? message(locale, 'print.no_source') : null;
  const snapshotWarning = message(locale, 'print.snapshot_warning');
  const empty = message(locale, 'print.empty');
  const openAuthorized = message(locale, 'print.open_authorized');
  const browserAction = message(locale, 'print.browser_action');
  const affordances = createAffordanceGroup(`print-translation-${instanceId}`, [
    title, ...(sourceUnavailable === null ? [] : [sourceUnavailable]),
    ...(snapshot === null ? [] : [sourceVersion, asOf, ...(noSource === null ? [] : [noSource]), snapshotWarning,
      ...(snapshot.items.length === 0 ? [empty] : []), openAuthorized, browserAction]),
  ]);
  return <section aria-labelledby="print-heading" data-print-schedule data-locale-pending={localeReady ? undefined : ''}>
    <h1 id="print-heading"><CatalogText group={affordances} value={title} /></h1>
    <p role="status" aria-live="polite">{sourceUnavailable === null ? null : <CatalogText group={affordances} value={sourceUnavailable} />}</p>
    {snapshot && <>
      <p><CatalogText group={affordances} value={sourceVersion} />: <span lang="en">{snapshot.source_version}</span></p>
      <p><CatalogText group={affordances} value={asOf} replacements={{ date: snapshot.as_of }} /></p>
      {noSource === null ? null : <p><CatalogText group={affordances} value={noSource} /></p>}
      <p><CatalogText group={affordances} value={snapshotWarning} /></p>
      {snapshot.items.length ? <ol>{snapshot.items.map((item,index) => <li key={index}><dl>{Object.entries(item).map(([key,value]) => <div key={key}><dt>{key.replaceAll('_',' ')}</dt><dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd></div>)}</dl></li>)}</ol> : <p><CatalogText group={affordances} value={empty} /></p>}
      <a aria-describedby={affordances.describedBy(openAuthorized)} className="ss-primary-action ss-print-action" href="/api/v1/me/schedule/print" target="_blank" rel="noopener"><CatalogText group={affordances} value={openAuthorized} /></a>
      <p className="ss-print-action"><CatalogText group={affordances} value={browserAction} /></p>
    </>}
    <AffordanceNotices group={affordances} />
  </section>;
}
