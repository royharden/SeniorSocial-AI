'use client';

import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import {
  resolveCatalogMessage,
  type CatalogKey,
  type CatalogMessageRequest,
  type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import type { SupportedLocale } from '@seniorsocial/ui';
import type { AssistanceRequestRecord, ConciergeAnswer, ConciergeConversation } from './types.ts';

type BusyAction = 'start' | 'ask' | 'handoff' | null;

type ConciergeCopy = Readonly<{
  heading: CatalogResolution;
  intro: CatalogResolution;
  startLabel: CatalogResolution;
  questionLabel: CatalogResolution;
  questionPlaceholder: CatalogResolution;
  askLabel: CatalogResolution;
  directoryLabel: CatalogResolution;
  handoffHeading: CatalogResolution;
  handoffNotice: CatalogResolution;
  confirmLabel: CatalogResolution;
  handoffLabel: CatalogResolution;
  savedHeading: CatalogResolution;
  pendingState: CatalogResolution;
  errorMessage: CatalogResolution;
}>;

type StatusKind = 'intro' | 'handoff' | null;

const ordinaryNoticeId = 'concierge-ordinary-translation-state';
const criticalNoticeId = 'concierge-critical-translation-state';

function descriptionId(value: CatalogResolution): string | undefined {
  if (!value.affordance) return undefined;
  return value.critical ? criticalNoticeId : ordinaryNoticeId;
}

export function Message({ value }: { readonly value: CatalogResolution }) {
  if (!value.found) return null;
  const catalogKey = `${value.namespace}.${value.key}`;
  return <span
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={catalogKey}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale}
  >
    {value.text}
  </span>;
}

export function CatalogNotice({ id, value }: {
  readonly id: string;
  readonly value: CatalogResolution | undefined;
}) {
  if (!value?.affordance) return null;
  return <small
    data-catalog-affordance={value.renderState}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    id={id}
    lang="en">{value.affordance}</small>;
}

function firstNotice(values: readonly CatalogResolution[], critical: boolean): CatalogResolution | undefined {
  return values.find(value => Boolean(value.affordance) && value.critical === critical);
}

export function resolveConciergeCopy(
  locale: SupportedLocale,
  resolveMessage: typeof resolveCatalogMessage = resolveCatalogMessage,
): ConciergeCopy {
  const catalogMessage = <Namespace extends CatalogMessageRequest['namespace']>(
    requestedLocale: SupportedLocale,
    namespace: Namespace,
    key: CatalogKey<Namespace>,
  ) => resolveMessage({ locale: requestedLocale, namespace, key } as CatalogMessageRequest);
  return {
    heading: catalogMessage(locale, 'services', 'directory.heading'),
    intro: catalogMessage(locale, 'services', 'directory.intro'),
    startLabel: catalogMessage(locale, 'services', 'directory.help_link'),
    questionLabel: catalogMessage(locale, 'services', 'directory.search_label'),
    questionPlaceholder: catalogMessage(locale, 'services', 'directory.search_placeholder'),
    askLabel: catalogMessage(locale, 'services', 'directory.search_action'),
    directoryLabel: catalogMessage(locale, 'shell', 'service_link'),
    handoffHeading: catalogMessage(locale, 'assistance', 'request.form_heading'),
    handoffNotice: catalogMessage(locale, 'assistance', 'request.unassigned_notice'),
    confirmLabel: catalogMessage(locale, 'common', 'confirm'),
    handoffLabel: catalogMessage(locale, 'assistance', 'request.send'),
    savedHeading: catalogMessage(locale, 'assistance', 'request.saved_heading'),
    pendingState: catalogMessage(locale, 'assistance', 'request.pending_state'),
    errorMessage: catalogMessage(locale, 'assistance', 'request.error'),
  };
}

const flowStyle: CSSProperties = { display: 'grid', gap: 'var(--ss-target-gap)' };
const textareaStyle: CSSProperties = {
  background: 'var(--ss-surface)',
  border: 'var(--ss-control-width) solid var(--ss-control-border)',
  borderRadius: 'var(--ss-radius)',
  color: 'var(--ss-text)',
  font: 'inherit',
  minHeight: 'calc(var(--ss-target) * 2)',
  padding: '0.75rem',
  resize: 'vertical',
  width: '100%',
};
const confirmationStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: '0.75rem',
  minHeight: 'var(--ss-target)',
  paddingBlock: '0.25rem',
};

type ConciergeViewProps = Readonly<{
  answer: ConciergeAnswer | null;
  assistance: AssistanceRequestRecord | null;
  busy: BusyAction;
  confirmed: boolean;
  conversation: ConciergeConversation | null;
  copy: ConciergeCopy;
  error: boolean;
  hydrated: boolean;
  onAsk: (event: FormEvent) => void;
  onConfirmedChange: (confirmed: boolean) => void;
  onHandoff: () => void;
  onQuestionChange: (question: string) => void;
  onStart: () => void;
  question: string;
  status: string;
  statusKind: StatusKind;
}>;

export function ConciergeView({
  answer, assistance, busy, confirmed, conversation, copy, error, hydrated,
  onAsk, onConfirmedChange, onHandoff, onQuestionChange, onStart, question, status, statusKind,
}: ConciergeViewProps) {
  const {
    askLabel, confirmLabel, directoryLabel, errorMessage, handoffHeading, handoffLabel, handoffNotice,
    heading, intro, pendingState, questionLabel, questionPlaceholder, savedHeading, startLabel,
  } = copy;
  const ordinaryValues = [heading, intro, startLabel];
  if (conversation) ordinaryValues.push(
    questionLabel, questionPlaceholder, askLabel, directoryLabel, confirmLabel,
  );
  const criticalValues = conversation
    ? [handoffHeading, handoffNotice, handoffLabel]
    : [];
  if (error) criticalValues.unshift(errorMessage);
  if (statusKind === 'handoff') criticalValues.unshift(savedHeading, pendingState);
  const ordinaryNotice = firstNotice(ordinaryValues, false);
  const criticalNotice = firstNotice(criticalValues, true);

  return <section aria-busy={busy !== null} aria-labelledby="concierge-heading" style={flowStyle}>
    <h1 aria-describedby={descriptionId(heading)} id="concierge-heading"><Message value={heading} /></h1>
    <p aria-describedby={descriptionId(intro)}><Message value={intro} /></p>
    <CatalogNotice id={ordinaryNoticeId} value={ordinaryNotice} />
    <CatalogNotice id={criticalNoticeId} value={criticalNotice} />
    <p
      aria-atomic="true"
      aria-describedby={statusKind === 'handoff'
        ? descriptionId(savedHeading) ?? descriptionId(pendingState)
        : statusKind === 'intro' ? descriptionId(intro) : undefined}
      aria-live="polite"
      role="status"
    >{statusKind === 'intro' ? <Message value={intro} /> : statusKind === 'handoff'
        ? <><Message value={savedHeading} /> <Message value={pendingState} /> {assistance?.id}</>
        : status}</p>
    <p aria-atomic="true" aria-describedby={error ? descriptionId(errorMessage) : undefined} aria-live="assertive" role="alert">
      {error ? <Message value={errorMessage} /> : null}
    </p>

    {!conversation ? <button
      aria-describedby={descriptionId(startLabel)}
      className="ss-primary-action"
      disabled={!hydrated || busy !== null}
      onClick={onStart}
      type="button"
    ><Message value={startLabel} /></button> : <>
      {conversation.ai_enabled ? <form onSubmit={onAsk} style={flowStyle}>
        <label htmlFor="concierge-question"><strong><Message value={questionLabel} /></strong></label>
        <textarea
          aria-describedby={descriptionId(questionPlaceholder) ?? descriptionId(questionLabel)}
          disabled={busy !== null}
          id="concierge-question"
          lang={questionPlaceholder.renderedLocale ?? undefined}
          maxLength={1000}
          onChange={event => onQuestionChange(event.target.value)}
          placeholder={questionPlaceholder.text}
          rows={4}
          style={textareaStyle}
          value={question}
        />
        <button aria-describedby={descriptionId(askLabel)} className="ss-primary-action" disabled={busy !== null || !question.trim()} type="submit">
          <Message value={askLabel} />
        </button>
      </form> : null}

      <p aria-describedby={descriptionId(directoryLabel)}><a href="/services"><Message value={directoryLabel} /></a></p>
      <section aria-describedby={descriptionId(heading)} aria-label={heading.text} aria-live="polite" aria-relevant="additions text">
        {answer ? <><p style={{ whiteSpace: 'pre-line' }}>{answer.text}</p><p>{answer.disclaimer}</p>{answer.citations.length > 0 ? <ul aria-label={heading.text}>{answer.citations.map(citation => <li key={citation}>{citation}</li>)}</ul> : null}</> : null}
      </section>

      <section aria-labelledby="human-handoff" className="ss-card" style={flowStyle}>
        <h2 aria-describedby={descriptionId(handoffHeading)} id="human-handoff"><Message value={handoffHeading} /></h2>
        <p aria-describedby={descriptionId(handoffNotice)}><Message value={handoffNotice} /></p>
        <label style={confirmationStyle}><input
          aria-describedby={descriptionId(confirmLabel)}
          checked={confirmed}
          disabled={busy !== null || Boolean(assistance)}
          onChange={event => onConfirmedChange(event.target.checked)}
          type="checkbox"
        /><Message value={confirmLabel} /></label>
        <button
          aria-describedby={descriptionId(handoffLabel)}
          className="ss-primary-action"
          disabled={busy !== null || !confirmed || Boolean(assistance)}
          onClick={onHandoff}
          type="button"
        ><Message value={handoffLabel} /></button>
      </section>
    </>}
  </section>;
}

export function ConciergeClient({ locale }: { readonly locale: SupportedLocale }) {
  const [hydrated, setHydrated] = useState(false);
  const [conversation, setConversation] = useState<ConciergeConversation | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<ConciergeAnswer | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [assistance, setAssistance] = useState<AssistanceRequestRecord | null>(null);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState<StatusKind>(null);
  const [error, setError] = useState(false);

  useEffect(() => setHydrated(true), []);

  // No dedicated reviewed concierge namespace exists. These catalog messages
  // retain the directory and human-assistance meaning, and the resolver holds
  // unreviewed Spanish content in English with its required affordance.
  const copy = resolveConciergeCopy(locale);

  async function start(): Promise<void> {
    setBusy('start');
    setError(false);
    setStatus('');
    setStatusKind(null);
    try {
      const response = await fetch('/api/v1/concierge/conversations', { method: 'POST' });
      if (!response.ok) throw new Error('start failed');
      setConversation(await response.json() as ConciergeConversation);
      setStatus(copy.intro.text);
      setStatusKind('intro');
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  async function ask(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!conversation || !question.trim()) return;
    setBusy('ask');
    setError(false);
    setStatus('');
    setStatusKind(null);
    try {
      const response = await fetch(`/api/v1/concierge/conversations/${conversation.id}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: question, locale }),
      });
      if (!response.ok) throw new Error('message failed');
      setAnswer(await response.json() as ConciergeAnswer);
      const refreshed = await fetch(`/api/v1/concierge/conversations/${conversation.id}`, { cache: 'no-store' });
      if (refreshed.ok) setConversation(await refreshed.json() as ConciergeConversation);
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  async function handoff(): Promise<void> {
    if (!conversation || !confirmed) return;
    setBusy('handoff');
    setError(false);
    setStatus('');
    setStatusKind(null);
    try {
      const response = await fetch(`/api/v1/concierge/conversations/${conversation.id}/handoff`, { method: 'POST' });
      if (!response.ok) throw new Error('handoff failed');
      const created = await response.json() as AssistanceRequestRecord;
      setAssistance(created);
      setStatus(`${copy.savedHeading.text} ${copy.pendingState.text} ${created.id}`);
      setStatusKind('handoff');
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  }

  return <ConciergeView
    answer={answer}
    assistance={assistance}
    busy={busy}
    confirmed={confirmed}
    conversation={conversation}
    copy={copy}
    error={error}
    hydrated={hydrated}
    onAsk={event => void ask(event)}
    onConfirmedChange={setConfirmed}
    onHandoff={() => void handoff()}
    onQuestionChange={setQuestion}
    onStart={() => void start()}
    question={question}
    status={status}
    statusKind={statusKind}
  />;
}
