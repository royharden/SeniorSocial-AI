'use client';

import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { CatalogText } from './catalog-text';

type Locale = 'en' | 'es';
type Result = { id: string; state: 'pending_unowned'; after_hours: boolean };
type Notice =
  | { readonly kind: 'saving' | 'error'; readonly revision: number }
  | { readonly kind: 'saved'; readonly result: Result; readonly revision: number };
type NoticeInput =
  | { readonly kind: 'saving' | 'error' }
  | { readonly kind: 'saved'; readonly result: Result };

const formStyle: CSSProperties = { display: 'grid', gap: 'var(--ss-target-gap)', maxWidth: '100%' };
const labelStyle: CSSProperties = { display: 'grid', gap: '0.375rem', maxWidth: '100%' };
const controlStyle: CSSProperties = {
  background: 'var(--ss-surface)', border: 'var(--ss-control-width) solid var(--ss-control-border)',
  borderRadius: 'var(--ss-radius)', color: 'var(--ss-text)', font: 'inherit', minHeight: 'var(--ss-target)',
  minWidth: 0, padding: '0.5rem 0.75rem', width: '100%',
};
const focusStyle: CSSProperties = {
  boxShadow: '0 0 0 0.125rem var(--ss-focus-inner)',
  outline: '0.1875rem solid var(--ss-focus-outer)', outlineOffset: '0.375rem',
};

function message(locale: Locale, key: CatalogMessageRequest<'assistance'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'assistance', key });
}

export function AssistanceForm({ locale }: { readonly locale: Locale }) {
  const [hydrated, setHydrated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => { setHydrated(true); }, []);

  function announce(value: NoticeInput) {
    setNotice(current => ({ ...value, revision: (current?.revision ?? 0) + 1 }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || busy) return;
    setBusy(true);
    announce({ kind: 'saving' });
    const form = new FormData(event.currentTarget);
    try {
      idempotencyKey.current ??= crypto.randomUUID();
      const response = await fetch('/api/v1/assistance-requests', {
        method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey.current },
        body: JSON.stringify({ summary: form.get('summary'), locale }),
      });
      if (!response.ok) throw new Error('request failed');
      announce({ kind: 'saved', result: await response.json() as Result });
    } catch { announce({ kind: 'error' }); }
    finally { setBusy(false); }
  }

  return (
    <form aria-busy={busy} className="ss-card" data-assistance-form onSubmit={event => { void submit(event); }} style={formStyle}>
      <h2><CatalogText value={message(locale, 'request.form_heading')} /></h2>
      <label htmlFor="assistance-summary" style={labelStyle}><CatalogText value={message(locale, 'request.details_label')} /></label>
      <textarea
        disabled={!hydrated || busy}
        id="assistance-summary"
        maxLength={2000}
        name="summary"
        onBlur={() => { setFocused(false); }}
        onFocus={() => { setFocused(true); }}
        required
        rows={6}
        style={focused ? { ...controlStyle, ...focusStyle } : controlStyle}
      />
      <p><CatalogText value={message(locale, 'request.unassigned_notice')} /></p>
      <button className="ss-primary-action" disabled={!hydrated || busy} type="submit">
        <CatalogText value={message(locale, 'request.send')} />
      </button>
      <div
        aria-atomic="true"
        aria-live={notice?.kind === 'error' ? 'assertive' : 'polite'}
        data-assistance-status
        role={notice?.kind === 'error' ? 'alert' : 'status'}
      >
        {notice === null ? null : <div key={notice.revision}>
          {notice.kind === 'saving' ? <CatalogText value={message(locale, 'request.saving')} /> : null}
          {notice.kind === 'error' ? <CatalogText value={message(locale, 'request.error')} /> : null}
          {notice.kind === 'saved' ? <>
            <h2><CatalogText value={message(locale, 'request.saved_heading')} /></h2>
            <p><CatalogText value={message(locale, 'request.pending_state')} /></p>
            <p><CatalogText value={message(locale, notice.result.after_hours ? 'request.after_hours' : 'request.normal_hours')} /></p>
          </> : null}
        </div>}
      </div>
    </form>
  );
}
