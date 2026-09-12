'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import styles from './data-export.module.css';

type Locale = 'en' | 'es';
type Mode = 'standard' | 'easy';
type ExportSection = 'profile' | 'requests' | 'consents' | 'audit' | 'proposals';
type ExportFormat = 'json' | 'csv';
type JobState = 'running' | 'ready' | 'failed';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ExportJob {
  readonly id: string;
  readonly state: JobState;
  readonly scope: readonly ExportSection[];
  readonly completeness_note: string;
  readonly download_url: string | null;
  readonly expires_at: string;
}

const sections: readonly ExportSection[] = ['profile', 'requests', 'consents', 'audit', 'proposals'];
const copy = {
  en: {
    heading: 'Export your data', intro: 'Create a personal copy of the account information you are authorized to access.',
    sections: 'Choose sections', profile: 'Profile', requests: 'Service requests', consents: 'Consent choices and history',
    audit: 'Activity history', proposals: 'Event suggestions', format: 'File format', json: 'JSON', csv: 'CSV (ZIP archive)',
    create: 'Create data export', pending: 'Your export request is pending.', ready: 'Your export is ready.',
    failed: 'The export could not be created. You can try the same request again.', unavailable: 'Export unavailable.',
    exactReplay: 'Retrying the exact request with the same replay key.', selectOne: 'Choose at least one section.',
    selected: 'Selected sections', chosenFormat: 'Format', completeness: 'Completeness or known gaps', expiry: 'Export request expires',
    download: 'Download your export', back: 'Back to settings', unknownExpiry: 'Not provided',
    criticalFallback: 'Critical information appears in English because approved Spanish is not available.',
  },
  es: {
    heading: 'Exporte sus datos', intro: 'Cree una copia personal de la información de la cuenta a la que tiene acceso autorizado.',
    sections: 'Elija las secciones', profile: 'Perfil', requests: 'Solicitudes de servicios', consents: 'Opciones e historial de consentimiento',
    audit: 'Historial de actividad', proposals: 'Sugerencias de eventos', format: 'Formato del archivo', json: 'JSON', csv: 'CSV (archivo ZIP)',
    create: 'Crear exportación de datos', pending: 'Su solicitud de exportación está pendiente.', ready: 'Su exportación está lista.',
    failed: 'The export could not be created. You can try the same request again.', unavailable: 'Export unavailable.',
    exactReplay: 'Retrying the exact request with the same replay key.', selectOne: 'Elija al menos una sección.',
    selected: 'Secciones seleccionadas', chosenFormat: 'Formato', completeness: 'Integridad o brechas conocidas', expiry: 'La solicitud de exportación vence',
    download: 'Descargar su exportación', back: 'Volver a configuración', unknownExpiry: 'No proporcionada',
    criticalFallback: 'La información crítica aparece en inglés porque no hay una traducción al español aprobada.',
  },
} as const;

function isJob(value: unknown): value is ExportJob {
  if (typeof value !== 'object' || value === null) return false;
  const job = value as Record<string, unknown>;
  const scope = Array.isArray(job.scope) ? job.scope : [];
  const downloadShape = job.state === 'ready' ? typeof job.download_url === 'string' : job.download_url === null;
  return typeof job.id === 'string' && uuid.test(job.id)
    && (job.state === 'running' || job.state === 'ready' || job.state === 'failed')
    && scope.length > 0 && scope.length <= sections.length
    && new Set(scope).size === scope.length && scope.every(item => sections.includes(item as ExportSection))
    && typeof job.completeness_note === 'string'
    && downloadShape
    && typeof job.expires_at === 'string' && !Number.isNaN(new Date(job.expires_at).getTime());
}

function formatExpiry(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return copy[locale].unknownExpiry;
  return new Intl.DateTimeFormat(locale === 'es' ? 'es-US' : 'en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(parsed);
}

function isSafeDownloadUrl(value: string, jobId: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || typeof window === 'undefined') return false;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin
      && url.username === '' && url.password === ''
      && url.pathname === `/api/v1/admin/exports/${jobId}/download`
      && url.search === '' && url.hash === '';
  } catch {
    return false;
  }
}

export function DataExportForm({ locale, mode }: { readonly locale: Locale; readonly mode: Mode }) {
  const text = copy[locale];
  const [hydrated, setHydrated] = useState(false);
  const [selected, setSelected] = useState<ExportSection[]>(['profile']);
  const [format, setFormat] = useState<ExportFormat>('json');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [noticeRevision, setNoticeRevision] = useState(0);
  const [criticalNotice, setCriticalNotice] = useState(false);
  const [job, setJob] = useState<ExportJob | null>(null);
  const attempts = useRef(new Map<string, { key: string; count: number }>());
  const signature = useMemo(() => JSON.stringify({ scope: [...selected].sort(), format }), [selected, format]);

  useEffect(() => setHydrated(true), []);

  function announce(message: string, critical = false) {
    setNoticeRevision(current => current + 1);
    setCriticalNotice(critical);
    setNotice(message);
  }

  function changeSection(section: ExportSection, checked: boolean) {
    setJob(null);
    setSelected(current => checked ? [...current, section] : current.filter(value => value !== section));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected.length === 0) { announce(text.selectOne); return; }
    const previous = attempts.current.get(signature);
    const replay = previous !== undefined && previous.count > 0;
    const current = previous
      ? { ...previous, count: previous.count + 1 }
      : { key: crypto.randomUUID(), count: 1 };
    attempts.current.set(signature, current);
    setJob(null);
    setBusy(true);
    announce(replay ? text.exactReplay : text.pending, replay);
    try {
      const response = await fetch('/api/v1/admin/exports', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': current.key },
        body: JSON.stringify({ scope: selected, format }),
      });
      if (response.status === 404 || response.status === 410) {
        announce(text.unavailable, true);
        return;
      }
      if (!response.ok) { announce(text.failed, true); return; }
      const result: unknown = await response.json();
      if (!isJob(result)) { announce(text.failed, true); return; }
      setJob(result);
      announce(result.state === 'ready' ? text.ready : result.state === 'failed' ? text.failed : text.pending, result.state === 'failed');
    } catch {
      announce(text.failed, true);
    } finally {
      setBusy(false);
    }
  }

  const labels = sections.reduce<Record<ExportSection, string>>((all, section) => ({ ...all, [section]: text[section] }), {} as Record<ExportSection, string>);
  const downloadUrl = hydrated && job?.state === 'ready' && typeof job.download_url === 'string' && isSafeDownloadUrl(job.download_url, job.id)
    ? job.download_url : null;

  return <section aria-busy={!hydrated} aria-labelledby="data-export-heading" className={styles.page} data-data-export data-mode={mode}>
    <h1 id="data-export-heading">{text.heading}</h1>
    <p>{text.intro}</p>
    <p aria-atomic="true" aria-live="polite" data-export-status data-notice-revision={noticeRevision} role="status">
      <span data-render-state={criticalNotice && locale === 'es' ? 'held_english_fallback' : undefined} key={noticeRevision}
        lang={criticalNotice && locale === 'es' ? 'en' : locale}>{notice}</span>
    </p>
    {criticalNotice && locale === 'es' && notice
      ? <p data-i18n-affordance="held_english_fallback" lang="es" role="note">{text.criticalFallback}</p> : null}
    <form className={styles.form} onSubmit={event => void submit(event)}>
      <fieldset disabled={!hydrated || busy || job?.state === 'ready'}>
        <legend>{text.sections}</legend>
        <div className={styles.choices}>
          {sections.map(section => <label key={section}>
            <input checked={selected.includes(section)} name="scope" onChange={event => changeSection(section, event.target.checked)}
              type="checkbox" value={section} />
            <span>{labels[section]}</span>
          </label>)}
        </div>
      </fieldset>
      <fieldset disabled={!hydrated || busy || job?.state === 'ready'}>
        <legend>{text.format}</legend>
        <div className={styles.choices}>
          {(['json', 'csv'] as const).map(value => <label key={value}>
            <input checked={format === value} name="format" onChange={() => { setJob(null); setFormat(value); }} type="radio" value={value} />
            <span>{text[value]}</span>
          </label>)}
        </div>
      </fieldset>
      <button disabled={!hydrated || busy || job?.state === 'ready'} type="submit">{text.create}</button>
    </form>
    {job ? <section aria-labelledby="export-summary-heading" className="ss-card" data-export-summary>
      <h2 id="export-summary-heading">{job.state === 'ready' ? text.ready : job.state === 'failed' ? text.failed : text.pending}</h2>
      <dl className={styles.summary}>
        <div><dt>{text.selected}</dt><dd>{job.scope.map(section => labels[section]).join(', ')}</dd></div>
        <div><dt>{text.chosenFormat}</dt><dd>{format.toUpperCase()}</dd></div>
        <div><dt>{text.completeness}</dt><dd>{job.completeness_note}</dd></div>
        <div><dt>{text.expiry}</dt><dd><time dateTime={job.expires_at}>{formatExpiry(job.expires_at, locale)}</time></dd></div>
      </dl>
      {downloadUrl ? <a download href={downloadUrl}>{text.download}</a> : null}
    </section> : null}
    <p><a href="/settings">{text.back}</a></p>
  </section>;
}
