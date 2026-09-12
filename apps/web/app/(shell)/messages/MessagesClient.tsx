'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { resolveCatalogMessage, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import type { Conversation, Message } from '../../../../../packages/messaging/src/service.ts';
import { resolveMessagingCopy } from './copy';
import {
  CatalogAffordance,
  ResolvedText,
  catalogDescribedBy,
  catalogNoticeId,
  mergeDescribedBy,
} from './CatalogText';

export default function MessagesClient({ locale, userId }: { readonly locale: 'en' | 'es'; readonly userId: string | null }) {
  const t = useMemo(() => resolveMessagingCopy(locale), [locale]);
  const critical = useMemo(() => ({
    privacy: resolveCatalogMessage({ locale, namespace: 'messages', key: 'privacy.participant_only' }),
    reportHeading: resolveCatalogMessage({ locale, namespace: 'messages', key: 'report.heading' }),
    reportReason: resolveCatalogMessage({ locale, namespace: 'messages', key: 'report.reason_label' }),
    reportNote: resolveCatalogMessage({ locale, namespace: 'messages', key: 'report.note_label' }),
    reportSaved: resolveCatalogMessage({ locale, namespace: 'messages', key: 'report.saved' }),
    blockAction: resolveCatalogMessage({ locale, namespace: 'messages', key: 'block.action' }),
    blockSaved: resolveCatalogMessage({ locale, namespace: 'messages', key: 'block.saved' }),
    blockHelp: resolveCatalogMessage({ locale, namespace: 'messages', key: 'block.help' }),
  }), [locale]);
  const [items, setItems] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<CatalogResolution | null>(t.loading);
  const [busy, setBusy] = useState(false);
  const [body, setBody] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const focusNext = useRef<'heading' | 'editor'>('heading');
  const generation = useRef(0);
  const sendAttempt = useRef<{ text: string; conversation: string; key: string } | null>(null);
  const reportAttempt = useRef<{ text: string; conversation: string; key: string } | null>(null);
  const load = useCallback(async () => {
    if (!userId) { setStatus(t.signIn); return; }
    try {
      const response = await fetch('/api/v1/conversations', { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const page = await response.json() as { items: Conversation[] };
      setItems(page.items); setStatus(page.items.length ? null : t.empty);
    } catch { setItems([]); setStatus(t.unavailable); }
  }, [t, userId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!busy && selected) (focusNext.current === 'editor' ? editor.current : heading.current)?.focus();
  }, [selected, messages, busy]);
  async function open(conversation: Conversation, focus: 'heading' | 'editor' = 'heading') {
    const current = ++generation.current;
    focusNext.current = focus;
    setMessages([]); setSelected(null); setBody(''); setStatus(t.loading);
    try {
      const response = await fetch(`/api/v1/conversations/${conversation.id}/messages`, { cache: 'no-store' });
      if (!response.ok) throw new Error('unavailable');
      const page = await response.json() as { items: Message[] };
      if (current !== generation.current) return;
      setSelected(conversation); setMessages(page.items); setStatus(null);
    } catch {
      if (current !== generation.current) return;
      setMessages([]); setSelected(null); setStatus(t.unavailable);
    }
  }
  async function post(path: string, input: unknown, key?: string) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(input) });
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true);
    try {
      const response = await post('/api/v1/conversations', { participant_id: data.get('participant') });
      if (!response.ok) throw new Error('unavailable');
      const conversation = await response.json() as Conversation;
      await load(); await open(conversation);
    } catch { setStatus(t.unavailable); } finally { setBusy(false); }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy(true);
    if (sendAttempt.current?.text !== body || sendAttempt.current.conversation !== selected.id)
      sendAttempt.current = { text: body, conversation: selected.id, key: crypto.randomUUID() };
    try {
      const response = await post(`/api/v1/conversations/${selected.id}/messages`, { body }, sendAttempt.current.key);
      if (!response.ok) { if (response.status === 404) { setMessages([]); setSelected(null); } throw new Error('unavailable'); }
      await open(selected, 'editor'); sendAttempt.current = null; setStatus(t.sent);
    } catch { setStatus(t.retry); } finally { setBusy(false); }
  }
  async function report(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return; setBusy(true);
    const data = new FormData(event.currentTarget); const input = { reason: data.get('reason'), note: data.get('note') };
    const text = JSON.stringify(input);
    if (reportAttempt.current?.text !== text || reportAttempt.current.conversation !== selected.id)
      reportAttempt.current = { text, conversation: selected.id, key: crypto.randomUUID() };
    try {
      const response = await post(`/api/v1/conversations/${selected.id}/report`, input, reportAttempt.current.key);
      if (!response.ok) throw new Error('unavailable');
      setStatus(critical.reportSaved);
    } catch { setStatus(t.retry); } finally { setBusy(false); }
  }
  async function block() {
    if (!selected) return; setBusy(true);
    try {
      const response = await post('/api/v1/blocks', { user_id: selected.participant_ids.find(id => id !== userId) });
      if (!response.ok) throw new Error('unavailable');
      generation.current++; setSelected(null); setMessages([]); setBody(''); await load(); setStatus(critical.blockSaved);
    } catch { setStatus(t.retry); } finally { setBusy(false); }
  }
  const noticeId = (resolution: CatalogResolution, instance: string) => catalogNoticeId(resolution, instance);
  const describedBy = (resolution: CatalogResolution, instance: string) => (
    catalogDescribedBy(resolution, noticeId(resolution, instance))
  );
  const notice = (resolution: CatalogResolution, instance: string) => (
    <CatalogAffordance resolution={resolution} id={noticeId(resolution, instance)} />
  );
  const statusInstance = status ? `status-${status.key}` : 'status';
  return <section aria-labelledby="messages-title" lang={locale}>
    <h1 id="messages-title" ref={heading} tabIndex={-1} aria-describedby={describedBy(t.title, 'title')}><ResolvedText resolution={t.title} /></h1>
    {notice(t.title, 'title')}
    <p aria-describedby={describedBy(critical.privacy, 'privacy')}><ResolvedText resolution={critical.privacy} /></p>
    {notice(critical.privacy, 'privacy')}
    <p role="status" aria-live="polite" aria-describedby={status ? describedBy(status, statusInstance) : undefined}>
      {status ? <ResolvedText resolution={status} /> : null}
    </p>
    {status ? notice(status, statusInstance) : null}
    {userId && <>
      <form className="ss-card" onSubmit={event => void create(event)}>
        <h2 aria-describedby={describedBy(t.start, 'create-heading')}><ResolvedText resolution={t.start} /></h2>
        {notice(t.start, 'create-heading')}
        <label aria-describedby={describedBy(t.participant, 'participant-input')}><ResolvedText resolution={t.participant} /><input name="participant" required disabled={busy} aria-describedby={describedBy(t.participant, 'participant-input')} /></label>
        {notice(t.participant, 'participant-input')}
        <button disabled={busy} aria-describedby={describedBy(t.create, 'create-action')}><ResolvedText resolution={t.create} /></button>
        {notice(t.create, 'create-action')}
      </form>
      <ul>{items.map((item, index) => {
        const instance = `conversation-${index + 1}`;
        const selectNoticeId = noticeId(t.select, instance);
        const conversationNoticeId = noticeId(t.conversation, instance);
        return <li key={item.id}>
          <button disabled={busy} onClick={() => void open(item)} aria-describedby={mergeDescribedBy(
            catalogDescribedBy(t.select, selectNoticeId),
            catalogDescribedBy(t.conversation, conversationNoticeId),
          )}><ResolvedText resolution={t.select} /> <ResolvedText resolution={t.conversation} /> {index + 1}</button>
          <CatalogAffordance resolution={t.select} id={selectNoticeId} />
          <CatalogAffordance resolution={t.conversation} id={conversationNoticeId} />
        </li>;
      })}</ul>
      {selected && <article className="ss-card" aria-label={t.conversation.text}>
        <button disabled={busy} aria-describedby={describedBy(t.back, 'selected-back')} onClick={() => { generation.current++; setSelected(null); setMessages([]); heading.current?.focus(); }}><ResolvedText resolution={t.back} /></button>
        {notice(t.back, 'selected-back')}
        <button disabled={busy} aria-describedby={describedBy(t.refresh, 'selected-refresh')} onClick={() => void open(selected)}><ResolvedText resolution={t.refresh} /></button>
        {notice(t.refresh, 'selected-refresh')}
        <ol aria-label={t.title.text}>{messages.map(message => <li key={message.id}><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.body}</p><time dateTime={message.sent_at}>{new Date(message.sent_at).toLocaleString(locale)}</time></li>)}</ol>
        <form onSubmit={event => void send(event)}>
          <label aria-describedby={describedBy(t.body, 'message-body')}><ResolvedText resolution={t.body} /><textarea ref={editor} required maxLength={4000} value={body} onChange={event => setBody(event.target.value)} disabled={busy} aria-describedby={describedBy(t.body, 'message-body')} /></label>
          {notice(t.body, 'message-body')}
          <button disabled={busy} aria-describedby={describedBy(t.send, 'send-action')}><ResolvedText resolution={t.send} /></button>
          {notice(t.send, 'send-action')}
        </form>
        <form onSubmit={event => void report(event)}>
          <h2 aria-describedby={describedBy(critical.reportHeading, 'report-heading')}><ResolvedText resolution={critical.reportHeading} /></h2>
          {notice(critical.reportHeading, 'report-heading')}
          <label aria-describedby={describedBy(critical.reportReason, 'report-reason')}><ResolvedText resolution={critical.reportReason} /><input name="reason" required maxLength={200} disabled={busy} aria-describedby={describedBy(critical.reportReason, 'report-reason')} /></label>
          {notice(critical.reportReason, 'report-reason')}
          <label aria-describedby={describedBy(critical.reportNote, 'report-note')}><ResolvedText resolution={critical.reportNote} /><textarea name="note" maxLength={2000} disabled={busy} aria-describedby={describedBy(critical.reportNote, 'report-note')} /></label>
          {notice(critical.reportNote, 'report-note')}
          <button disabled={busy} aria-describedby={describedBy(critical.reportHeading, 'report-action')}><ResolvedText resolution={critical.reportHeading} /></button>
          {notice(critical.reportHeading, 'report-action')}
        </form>
        <p aria-describedby={describedBy(critical.blockHelp, 'block-help')}><ResolvedText resolution={critical.blockHelp} /></p>
        {notice(critical.blockHelp, 'block-help')}
        <button disabled={busy} aria-describedby={describedBy(critical.blockAction, 'block-action')} onClick={() => void block()}><ResolvedText resolution={critical.blockAction} /></button>
        {notice(critical.blockAction, 'block-action')}
      </article>}
    </>}
    <p><a href="/settings/notifications" aria-describedby={describedBy(t.notice, 'notification-link')}><ResolvedText resolution={t.notice} /></a> {notice(t.notice, 'notification-link')}</p>
  </section>;
}
