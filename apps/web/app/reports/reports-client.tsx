'use client';

import {
  resolveCatalogMessage,
  type CatalogKey,
  type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { CanonicalReport, ReportRow } from '../../../../packages/reporting/src/index.ts';
import styles from './reports.module.css';

type Locale = 'en' | 'es';
type ReportKey = CatalogKey<'reports'>;

const reportKeys = {
  title: 'title',
  intro: 'intro',
  filters: 'filters',
  from: 'from',
  to: 'to',
  channel: 'channel',
  allChannels: 'all_channels',
  apply: 'apply',
  loading: 'loading',
  empty: 'empty',
  error: 'error',
  success: 'success',
  exportJson: 'export_json',
  exportCsv: 'export_csv',
  exported: 'exported',
  metadata: 'metadata',
  rows: 'rows',
  suppressed: 'suppressed',
  count: 'count',
  asOf: 'as_of',
  scope: 'scope',
  completeness: 'completeness',
  sourceVersion: 'source_version',
  knownOmissions: 'known_omissions',
  overlapUncertainty: 'overlap_uncertainty',
  noneDeclared: 'none_declared',
  period: 'period',
  metric: 'metric',
} as const satisfies Readonly<Record<string, ReportKey>>;

export type ReportsCopy = {
  readonly [Name in keyof typeof reportKeys]: CatalogResolution;
};

export function resolveReportsCopy(locale: Locale): ReportsCopy {
  return Object.fromEntries(Object.entries(reportKeys).map(([name, key]) => [
    name,
    resolveCatalogMessage({ locale, namespace: 'reports', key }),
  ])) as ReportsCopy;
}

export function CatalogText({ value }: { readonly value: CatalogResolution }) {
  const catalogKey = `${value.namespace}.${value.key}`;
  return <span
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={catalogKey}
    data-catalog-render-state={value.renderState}
    data-review-status={value.reviewStatus}
    lang={value.renderedLocale ?? undefined}
  >
    {value.text}
  </span>;
}

export function CatalogNotice({ id, value }: {
  readonly id: string;
  readonly value: CatalogResolution;
}) {
  if (value.affordance === null) return null;
  return <small
    data-catalog-affordance={value.renderState}
    data-catalog-key={`${value.namespace}.${value.key}`}
    id={id}
    lang="en"
  >{value.affordance}</small>;
}

export function catalogDescriptionId(value: CatalogResolution, id: string) {
  return value.affordance === null ? undefined : id;
}

export function CatalogOption({ value, optionValue }: {
  readonly value: CatalogResolution;
  readonly optionValue: string;
}) {
  const catalogKey = `${value.namespace}.${value.key}`;
  return <option
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={catalogKey}
    data-catalog-render-state={value.renderState}
    data-review-status={value.reviewStatus}
    lang={value.renderedLocale ?? undefined}
    value={optionValue}
  >
    {value.text}
  </option>;
}

function countLabel(row: ReportRow, suppressed: CatalogResolution, noticeId: string) {
  return row.suppressed ? <>
    <span aria-describedby={catalogDescriptionId(suppressed, noticeId)}><CatalogText value={suppressed} /></span>
    <CatalogNotice id={noticeId} value={suppressed} />
  </> : String(row.count);
}

function readShellLocale(): Locale {
  const shellLocale = document.querySelector<HTMLElement>('.ss-app')?.dataset.locale;
  return shellLocale === 'es' || (shellLocale === undefined && document.documentElement.lang === 'es') ? 'es' : 'en';
}

export function ReportsClient() {
  const [locale, setLocale] = useState<Locale>('en');
  const [localeReady, setLocaleReady] = useState(false);
  const [report, setReport] = useState<CanonicalReport | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [noticeKey, setNoticeKey] = useState<ReportKey | null>(null);
  const text = useMemo(() => resolveReportsCopy(locale), [locale]);

  useEffect(() => {
    setLocale(readShellLocale());
    setLocaleReady(true);
  }, []);

  async function load(query = '') {
    setState('loading');
    setNoticeKey(null);
    try {
      const response = await fetch(`/api/v1/admin/reports/channel-activity${query}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json() as CanonicalReport;
      setReport(value);
      setState(value.rows.length === 0 ? 'empty' : 'ready');
      setNoticeKey('success');
    } catch {
      setState('error');
    }
  }

  useEffect(() => { void load(); }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const query = new URLSearchParams();
    for (const key of ['from', 'to', 'channel']) {
      const value = data.get(key);
      if (typeof value === 'string' && value) query.append(key, key === 'channel' ? value : `${value}T00:00:00.000Z`);
    }
    void load(query.size ? `?${query.toString()}` : '');
  }

  async function prepare(format: 'json' | 'csv') {
    setNoticeKey('loading');
    const response = await fetch('/api/v1/admin/exports', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() },
      body: JSON.stringify({ report_name: 'channel-activity', format, filters: report?.filters ?? {} }),
    });
    setNoticeKey(response.ok ? 'exported' : 'error');
  }

  const status = state === 'loading'
    ? text.loading
    : state === 'error'
      ? text.error
      : state === 'empty'
        ? text.empty
        : noticeKey === null
          ? null
          : resolveCatalogMessage({ locale, namespace: 'reports', key: noticeKey });

  const statusNoticeId = 'reports-status-notice';

  return <main className={styles.main} data-locale-pending={localeReady ? undefined : ''} lang={locale}>
    <header><div>
      <h1 aria-describedby={catalogDescriptionId(text.title, 'reports-title-notice')}><CatalogText value={text.title} /></h1>
      <CatalogNotice id="reports-title-notice" value={text.title} />
      <p aria-describedby={catalogDescriptionId(text.intro, 'reports-intro-notice')}><CatalogText value={text.intro} /></p>
      <CatalogNotice id="reports-intro-notice" value={text.intro} />
    </div></header>
    <form className={styles.filters} aria-labelledby="filters-title" onSubmit={submit}>
      <h2 aria-describedby={catalogDescriptionId(text.filters, 'reports-filters-notice')} id="filters-title"><CatalogText value={text.filters} /></h2>
      <CatalogNotice id="reports-filters-notice" value={text.filters} />
      <label htmlFor="reports-from"><CatalogText value={text.from} />
        <input aria-describedby={catalogDescriptionId(text.from, 'reports-from-notice')} id="reports-from" type="date" name="from" />
      </label>
      <CatalogNotice id="reports-from-notice" value={text.from} />
      <label htmlFor="reports-to"><CatalogText value={text.to} />
        <input aria-describedby={catalogDescriptionId(text.to, 'reports-to-notice')} id="reports-to" type="date" name="to" />
      </label>
      <CatalogNotice id="reports-to-notice" value={text.to} />
      <label htmlFor="reports-channel"><CatalogText value={text.channel} />
        <select
          aria-describedby={[
            catalogDescriptionId(text.channel, 'reports-channel-notice'),
            catalogDescriptionId(text.allChannels, 'reports-all-channels-notice'),
          ].filter(Boolean).join(' ') || undefined}
          id="reports-channel"
          name="channel"
        >
          <CatalogOption optionValue="" value={text.allChannels} />
          {(report?.included_channels ?? []).map(channel => <option key={channel}>{channel}</option>)}
        </select>
      </label>
      <CatalogNotice id="reports-channel-notice" value={text.channel} />
      <CatalogNotice id="reports-all-channels-notice" value={text.allChannels} />
      <button aria-describedby={catalogDescriptionId(text.apply, 'reports-apply-notice')}><CatalogText value={text.apply} /></button>
      <CatalogNotice id="reports-apply-notice" value={text.apply} />
    </form>
    <p
      aria-describedby={status === null ? undefined : catalogDescriptionId(status, statusNoticeId)}
      aria-live="polite"
      role={state === 'error' ? 'alert' : 'status'}
    >
      {status === null ? null : <CatalogText value={status} />}
    </p>
    {status === null ? null : <CatalogNotice id={statusNoticeId} value={status} />}
    {report ? <>
      <section aria-labelledby="metadata-title">
        <h2 aria-describedby={catalogDescriptionId(text.metadata, 'reports-metadata-notice')} id="metadata-title"><CatalogText value={text.metadata} /></h2>
        <CatalogNotice id="reports-metadata-notice" value={text.metadata} />
        <dl className={styles.metadata}>
          <div><dt aria-describedby={catalogDescriptionId(text.asOf, 'reports-as-of-notice')}><CatalogText value={text.asOf} /></dt><dd><time dateTime={report.as_of}>{report.as_of}</time><CatalogNotice id="reports-as-of-notice" value={text.asOf} /></dd></div>
          <div><dt aria-describedby={catalogDescriptionId(text.scope, 'reports-scope-notice')}><CatalogText value={text.scope} /></dt><dd>{report.scope}<CatalogNotice id="reports-scope-notice" value={text.scope} /></dd></div>
          <div><dt aria-describedby={catalogDescriptionId(text.completeness, 'reports-completeness-notice')}><CatalogText value={text.completeness} /></dt><dd>{report.completeness}<CatalogNotice id="reports-completeness-notice" value={text.completeness} /></dd></div>
          <div><dt aria-describedby={catalogDescriptionId(text.sourceVersion, 'reports-source-version-notice')}><CatalogText value={text.sourceVersion} /></dt><dd className={styles.wrap}>{report.source_version}<CatalogNotice id="reports-source-version-notice" value={text.sourceVersion} /></dd></div>
          <div><dt aria-describedby={catalogDescriptionId(text.knownOmissions, 'reports-known-omissions-notice')}><CatalogText value={text.knownOmissions} /></dt><dd>{report.known_omissions.length
            ? report.known_omissions.join('; ')
            : <span aria-describedby={catalogDescriptionId(text.noneDeclared, 'reports-known-omissions-none-notice')}><CatalogText value={text.noneDeclared} /></span>}
          <CatalogNotice id="reports-known-omissions-notice" value={text.knownOmissions} />
          {report.known_omissions.length ? null : <CatalogNotice id="reports-known-omissions-none-notice" value={text.noneDeclared} />}</dd></div>
          <div><dt aria-describedby={catalogDescriptionId(text.overlapUncertainty, 'reports-overlap-uncertainty-notice')}><CatalogText value={text.overlapUncertainty} /></dt><dd>{report.overlap_uncertainty.length
            ? report.overlap_uncertainty.join('; ')
            : <span aria-describedby={catalogDescriptionId(text.noneDeclared, 'reports-overlap-uncertainty-none-notice')}><CatalogText value={text.noneDeclared} /></span>}
          <CatalogNotice id="reports-overlap-uncertainty-notice" value={text.overlapUncertainty} />
          {report.overlap_uncertainty.length ? null : <CatalogNotice id="reports-overlap-uncertainty-none-notice" value={text.noneDeclared} />}</dd></div>
        </dl>
      </section>
      <section aria-labelledby="rows-title">
        <h2 aria-describedby={catalogDescriptionId(text.rows, 'reports-rows-notice')} id="rows-title"><CatalogText value={text.rows} /></h2>
        <CatalogNotice id="reports-rows-notice" value={text.rows} />
        {report.rows.length ? <div className={styles.tableWrap}><table><thead><tr>
          <th aria-describedby={catalogDescriptionId(text.period, 'reports-period-notice')}><CatalogText value={text.period} /></th>
          <th aria-describedby={catalogDescriptionId(text.channel, 'reports-table-channel-notice')}><CatalogText value={text.channel} /></th>
          <th aria-describedby={catalogDescriptionId(text.metric, 'reports-metric-notice')}><CatalogText value={text.metric} /></th>
          <th aria-describedby={catalogDescriptionId(text.count, 'reports-count-notice')}><CatalogText value={text.count} /></th>
        </tr></thead><tbody>{report.rows.map((row, index) => <tr key={`${row.period}-${row.channel}-${row.metric}`}>
          <td>{row.period}</td><td>{row.channel}</td><td>{row.metric}</td><td>{countLabel(row, text.suppressed, `reports-suppressed-${index}-notice`)}</td>
        </tr>)}</tbody></table>
        <CatalogNotice id="reports-period-notice" value={text.period} />
        <CatalogNotice id="reports-table-channel-notice" value={text.channel} />
        <CatalogNotice id="reports-metric-notice" value={text.metric} />
        <CatalogNotice id="reports-count-notice" value={text.count} />
        </div> : <p aria-describedby={catalogDescriptionId(text.empty, 'reports-empty-notice')}><CatalogText value={text.empty} /><CatalogNotice id="reports-empty-notice" value={text.empty} /></p>}
      </section>
      <div className={styles.actions}>
        <button aria-describedby={catalogDescriptionId(text.exportJson, 'reports-export-json-notice')} type="button" onClick={() => void prepare('json')}><CatalogText value={text.exportJson} /></button>
        <CatalogNotice id="reports-export-json-notice" value={text.exportJson} />
        <button aria-describedby={catalogDescriptionId(text.exportCsv, 'reports-export-csv-notice')} type="button" onClick={() => void prepare('csv')}><CatalogText value={text.exportCsv} /></button>
        <CatalogNotice id="reports-export-csv-notice" value={text.exportCsv} />
      </div>
    </> : null}
  </main>;
}
