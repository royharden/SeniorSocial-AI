'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { TranslationDraft, TranslationView } from '@seniorsocial/i18n';
import {
  catalogs,
  resolveCatalogMessage,
  type CatalogKey,
  type CatalogMessageRequest,
  type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';

export type TranslationLocale = 'en' | 'es';
type TranslationKey = CatalogKey<'translate'>;
export type TranslationMessageResolver = (
  input: CatalogMessageRequest<'translate'>,
) => CatalogResolution;

const translationKeys = Object.keys(catalogs.en.translate) as TranslationKey[];

type AffordanceGroup = {
  readonly notices: readonly { readonly id: string; readonly text: string }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const texts = [...new Set(values.flatMap(value => value.found && value.affordance !== null ? [value.affordance] : []))];
  const notices = texts.map((text, index) => ({ id: `${prefix}-${index + 1}`, text }));
  return {
    notices,
    describedBy(value) {
      if (!value.found || value.affordance === null) return undefined;
      return notices.find(notice => notice.text === value.affordance)?.id;
    },
  };
}

function ResolvedText({ value, describedBy }: {
  readonly value: CatalogResolution;
  readonly describedBy: string | undefined;
}) {
  if (!value.found) return null;
  return (
    <span
      aria-describedby={describedBy}
      data-i18n-key={`${value.namespace}.${value.key}`}
      data-render-state={value.renderState}
      lang={value.renderedLocale}
    >
      {value.text}
    </span>
  );
}

function AffordanceNotices({ group }: { readonly group: AffordanceGroup }) {
  if (group.notices.length === 0) return null;
  return <div data-i18n-affordance-group>
    {group.notices.map(notice => (
      <small data-i18n-affordance id={notice.id} key={notice.id} lang="en" role="note">{notice.text}</small>
    ))}
  </div>;
}

export default function TranslationWorkbench({
  locale,
  resolveMessage = resolveCatalogMessage,
}: {
  readonly locale: TranslationLocale;
  readonly resolveMessage?: TranslationMessageResolver;
}) {
  const instanceId = useId().replaceAll(':', '');
  const copy = useMemo(() => Object.fromEntries(translationKeys.map(key => [
    key,
    resolveMessage({ locale, namespace: 'translate', key }),
  ])) as Record<TranslationKey, CatalogResolution>, [locale, resolveMessage]);
  const [items, setItems] = useState<readonly TranslationView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [sourceKey, setSourceKey] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [critical, setCritical] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [reviewNote, setReviewNote] = useState('');
  const [messageKey, setMessageKey] = useState<TranslationKey | null>(null);
  const selected = useMemo(() => items.find(item => item.source.id === selectedId), [items, selectedId]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/admin/translations', { cache: 'no-store' });
      if (!response.ok) throw new Error('load');
      const loaded = (await response.json() as { items: readonly TranslationView[] }).items;
      setItems(loaded);
      setSelectedId(current => current || loaded[0]?.source.id || '');
    } catch {
      setMessageKey('load_failed');
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function act(body: Record<string, unknown>, endpoint = '/api/v1/admin/translations') {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setMessageKey(response.status === 503 ? 'ai_off' : 'load_failed');
        return;
      }
      setMessageKey('action_complete');
      await refresh();
    } catch {
      setMessageKey('load_failed');
    }
  }

  function status(entry: TranslationDraft): CatalogResolution {
    return copy[`status_${entry.status}` as TranslationKey];
  }

  const activeMessage = copy[messageKey ?? 'ai_off'];
  const headerAffordances = createAffordanceGroup(`${instanceId}-header-affordance`, [copy.title, copy.intro, activeMessage]);
  const sourceAffordances = createAffordanceGroup(`${instanceId}-source-affordance`, [
    copy.source_key, copy.source_text, copy.critical, copy.create_source,
  ]);
  const selectAffordances = createAffordanceGroup(`${instanceId}-select-affordance`, [copy.select_source]);
  const draftAffordances = createAffordanceGroup(`${instanceId}-draft-affordance`, [copy.spanish_text, copy.manual, copy.machine]);
  const policyAffordances = createAffordanceGroup(`${instanceId}-policy-affordance`, [copy.critical_hold, copy.no_promises]);
  const sourceVersionAffordances = createAffordanceGroup(`${instanceId}-source-version-affordance`, [copy.source_version]);

  return (
    <main>
      <h1><ResolvedText describedBy={headerAffordances.describedBy(copy.title)} value={copy.title} /></h1>
      <p><ResolvedText describedBy={headerAffordances.describedBy(copy.intro)} value={copy.intro} /></p>
      <p role="status"><ResolvedText describedBy={headerAffordances.describedBy(activeMessage)} value={activeMessage} /></p>
      <AffordanceNotices group={headerAffordances} />
      <form
        aria-label={copy.create_source.text}
        aria-describedby={sourceAffordances.describedBy(copy.create_source)}
        onSubmit={event => {
          event.preventDefault();
          void act({ action: 'source', key: sourceKey, text: sourceText, critical });
        }}
      >
        <label>
          <ResolvedText describedBy={sourceAffordances.describedBy(copy.source_key)} value={copy.source_key} />
          <input aria-describedby={sourceAffordances.describedBy(copy.source_key)} aria-label={copy.source_key.text}
            value={sourceKey} onChange={event => setSourceKey(event.target.value)} required />
        </label>
        <label>
          <ResolvedText describedBy={sourceAffordances.describedBy(copy.source_text)} value={copy.source_text} />
          <textarea aria-describedby={sourceAffordances.describedBy(copy.source_text)} aria-label={copy.source_text.text}
            value={sourceText} onChange={event => setSourceText(event.target.value)} required />
        </label>
        <label>
          <input aria-describedby={sourceAffordances.describedBy(copy.critical)} aria-label={copy.critical.text}
            type="checkbox" checked={critical} onChange={event => setCritical(event.target.checked)} />
          <ResolvedText describedBy={sourceAffordances.describedBy(copy.critical)} value={copy.critical} />
        </label>
        <button aria-describedby={sourceAffordances.describedBy(copy.create_source)} type="submit" aria-label={copy.create_source.text}>
          <ResolvedText describedBy={sourceAffordances.describedBy(copy.create_source)} value={copy.create_source} />
        </button>
      </form>
      <AffordanceNotices group={sourceAffordances} />
      <label>
        <ResolvedText describedBy={selectAffordances.describedBy(copy.select_source)} value={copy.select_source} />
        <select aria-describedby={selectAffordances.describedBy(copy.select_source)} aria-label={copy.select_source.text}
          value={selectedId} onChange={event => setSelectedId(event.target.value)}>
          <option lang={copy.select_source.renderedLocale ?? undefined} value="">{copy.select_source.text}</option>
          {items.map(item => <option key={item.source.id} value={item.source.id}>{item.source.key}</option>)}
        </select>
      </label>
      <AffordanceNotices group={selectAffordances} />
      <form onSubmit={event => { event.preventDefault(); if (selectedId) void act({ action: 'draft', sourceId: selectedId, text: draftText }); }}>
        <label>
          <ResolvedText describedBy={draftAffordances.describedBy(copy.spanish_text)} value={copy.spanish_text} />
          <textarea aria-describedby={draftAffordances.describedBy(copy.spanish_text)} aria-label={copy.spanish_text.text}
            value={draftText} onChange={event => setDraftText(event.target.value)} required />
        </label>
        <button aria-describedby={draftAffordances.describedBy(copy.manual)} type="submit" aria-label={copy.manual.text} disabled={!selectedId}>
          <ResolvedText describedBy={draftAffordances.describedBy(copy.manual)} value={copy.manual} />
        </button>
        <button
          type="button"
          aria-label={copy.machine.text}
          aria-describedby={draftAffordances.describedBy(copy.machine)}
          disabled={!selectedId}
          onClick={() => void act({ action: 'draft', sourceId: selectedId, machine: true })}
        >
          <ResolvedText describedBy={draftAffordances.describedBy(copy.machine)} value={copy.machine} />
        </button>
      </form>
      <AffordanceNotices group={draftAffordances} />
      <p><ResolvedText describedBy={policyAffordances.describedBy(copy.critical_hold)} value={copy.critical_hold} /></p>
      <p><ResolvedText describedBy={policyAffordances.describedBy(copy.no_promises)} value={copy.no_promises} /></p>
      <AffordanceNotices group={policyAffordances} />
      {selected && (
        <section>
          <h2>{selected.source.key}</h2>
          <p>
            <ResolvedText describedBy={sourceVersionAffordances.describedBy(copy.source_version)} value={copy.source_version} />
            : {selected.source.version} · {selected.source.hash}
          </p>
          <AffordanceNotices group={sourceVersionAffordances} />
          <p lang="en">{selected.source.text}</p>
          <ol>{selected.history.map(entry => {
            const provenance = entry.machineGenerated ? copy.machine : copy.manual;
            const reviewStatus = status(entry);
            const publishability = entry.publishable ? copy.yes : copy.no;
            const values = [
              copy.provenance, provenance, copy.status, reviewStatus, copy.publishable, publishability,
              copy.reviewer, copy.qualification, copy.reviewed_at, copy.review_note, copy.approve, copy.publish,
            ];
            const entryAffordances = createAffordanceGroup(
              `${instanceId}-history-${entry.id}-affordance`, values,
            );
            return (
              <li aria-describedby={entryAffordances.notices.map(notice => notice.id).join(' ') || undefined} key={entry.id}>
                <p lang="es">{entry.text}</p>
                <dl>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.provenance)} value={copy.provenance} /></dt>
                  <dd><ResolvedText describedBy={entryAffordances.describedBy(provenance)} value={provenance} /></dd>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.status)} value={copy.status} /></dt>
                  <dd><ResolvedText describedBy={entryAffordances.describedBy(reviewStatus)} value={reviewStatus} /></dd>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.publishable)} value={copy.publishable} /></dt>
                  <dd><ResolvedText describedBy={entryAffordances.describedBy(publishability)} value={publishability} /></dd>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.reviewer)} value={copy.reviewer} /></dt>
                  <dd>{entry.reviewedBy ?? '—'}</dd>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.qualification)} value={copy.qualification} /></dt>
                  <dd>{entry.reviewerQualification ?? '—'}</dd>
                  <dt><ResolvedText describedBy={entryAffordances.describedBy(copy.reviewed_at)} value={copy.reviewed_at} /></dt>
                  <dd>{entry.reviewedAt ?? '—'}</dd>
                </dl>
                <label>
                  <ResolvedText describedBy={entryAffordances.describedBy(copy.review_note)} value={copy.review_note} />
                  <input aria-describedby={entryAffordances.describedBy(copy.review_note)} aria-label={copy.review_note.text}
                    value={reviewNote} onChange={event => setReviewNote(event.target.value)} />
                </label>
                <button
                  aria-describedby={entryAffordances.describedBy(copy.approve)}
                  type="button"
                  aria-label={copy.approve.text}
                  onClick={() => void act(
                    { source_version: `${entry.sourceVersion}:${entry.sourceHash}`, reviewer_note: reviewNote },
                    `/api/v1/admin/translations/${entry.id}/approve`,
                  )}
                >
                  <ResolvedText describedBy={entryAffordances.describedBy(copy.approve)} value={copy.approve} />
                </button>
                <button
                  aria-describedby={entryAffordances.describedBy(copy.publish)}
                  type="button"
                  aria-label={copy.publish.text}
                  onClick={() => void act({
                    action: 'publish', draftId: entry.id, sourceHash: entry.sourceHash, sourceVersion: entry.sourceVersion,
                  })}
                >
                  <ResolvedText describedBy={entryAffordances.describedBy(copy.publish)} value={copy.publish} />
                </button>
                <AffordanceNotices group={entryAffordances} />
              </li>
            );
          })}</ol>
        </section>
      )}
    </main>
  );
}
