'use client';

import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import {
  Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type FormEvent,
} from 'react';
import { formatEventDateTime, zonedLocalDateTimeToIso } from '../../../../../packages/events/src/timezone.ts';

type Locale = 'en' | 'es';
type EventKey = CatalogMessageRequest<'events'>['key'];
type EventMessageResolver = (input: CatalogMessageRequest<'events'>) => CatalogResolution;

interface EventItem {
  id: string;
  title: string;
  starts_at: string;
  time_zone: string;
  location: string;
  capacity: number | null;
  rsvp_count: number;
  accessibility: string[];
}

interface EventPage { items: EventItem[]; reasons?: Record<string, string> }

type NoticeState = {
  readonly keys: readonly EventKey[];
  readonly progress: boolean;
  readonly revision: number;
};

type AffordanceGroup = {
  readonly notices: readonly { readonly id: string; readonly text: string; readonly renderState: string }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const unique = new Map<string, string>();
  for (const value of values) {
    if (value.found && value.affordance !== null) unique.set(value.affordance, value.renderState);
  }
  const notices = [...unique].map(([text, renderState], index) => ({ id: `${prefix}-${index + 1}`, text, renderState }));
  return {
    notices,
    describedBy(value) {
      if (!value.found || value.affordance === null) return undefined;
      return notices.find(notice => notice.text === value.affordance)?.id;
    },
  };
}

function ResolvedText({ value, describedBy, text = value.text }: {
  readonly value: CatalogResolution;
  readonly describedBy: string | undefined;
  readonly text?: string;
}) {
  if (!value.found) return null;
  return <span
    aria-describedby={describedBy}
    data-i18n-key={`${value.namespace}.${value.key}`}
    data-render-state={value.renderState}
    lang={value.renderedLocale}
  >{text}</span>;
}

function AffordanceNotices({ group }: { readonly group: AffordanceGroup }) {
  if (group.notices.length === 0) return null;
  return <div data-i18n-affordance-group>
    {group.notices.map(notice => <small
      data-i18n-affordance={notice.renderState}
      id={notice.id}
      key={notice.id}
      lang="en"
      role="note"
    >{notice.text}</small>)}
  </div>;
}

function interpolateCount(template: string, count: number): string {
  return template.replaceAll('{count}', String(Math.max(0, Math.trunc(count))));
}

const flowStyle: CSSProperties = { display: 'grid', gap: 'var(--ss-target-gap)', minWidth: 0 };
const actionRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ss-target-gap)' };
const controlStyle: CSSProperties = {
  background: 'var(--ss-surface)', border: 'var(--ss-control-width) solid var(--ss-control-border)',
  borderRadius: 'var(--ss-radius)', color: 'var(--ss-text)', font: 'inherit', maxWidth: '100%',
  minHeight: 'var(--ss-target)', minWidth: 0, padding: '0.5rem 0.75rem', width: '100%',
};
const noteStyle: CSSProperties = { ...controlStyle, minHeight: 'calc(var(--ss-target) * 3)', resize: 'vertical' };
const focusProps = {
  onBlur: (event: React.FocusEvent<HTMLElement>) => {
    event.currentTarget.style.boxShadow = '';
    event.currentTarget.style.outline = '';
    event.currentTarget.style.outlineOffset = '';
  },
  onFocus: (event: React.FocusEvent<HTMLElement>) => {
    event.currentTarget.style.boxShadow = '0 0 0 0.125rem var(--ss-focus-inner)';
    event.currentTarget.style.outline = '0.1875rem solid var(--ss-focus-outer)';
    event.currentTarget.style.outlineOffset = '0.375rem';
  },
};

function progressText(text: string): string {
  return /[….]$/u.test(text) ? text : `${text}…`;
}

export function EventsContent({ resolveMessage = resolveCatalogMessage }: {
  readonly resolveMessage?: EventMessageResolver;
}) {
  const instanceId = useId().replaceAll(':', '');
  const [locale, setLocale] = useState<Locale>('en');
  const [ready, setReady] = useState(false);
  const [page, setPage] = useState<EventPage>({ items: [] });
  const [listNotice, setListNotice] = useState<NoticeState>({ keys: [], progress: false, revision: 0 });
  const [interactionNotice, setInteractionNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadSequence = useRef(0);
  const message = useCallback((key: EventKey) => resolveMessage({ locale, namespace: 'events', key }), [locale, resolveMessage]);
  const activeNotice = interactionNotice ?? listNotice;
  const noticeMessages = useMemo(() => activeNotice.keys.map(message), [activeNotice.keys, message]);

  const announceList = useCallback((keys: readonly EventKey[], progress = false) => {
    setListNotice(current => ({ keys, progress, revision: current.revision + 1 }));
  }, []);
  const announceInteraction = useCallback((keys: readonly EventKey[], progress = false) => {
    setInteractionNotice(current => ({ keys, progress, revision: (current?.revision ?? 0) + 1 }));
  }, []);

  const load = useCallback(async () => {
    const request = ++loadSequence.current;
    setLoading(true);
    try {
      const response = await fetch('/api/v1/recommendations/events', { cache: 'no-store' });
      if (request !== loadSequence.current) return;
      if (!response.ok) {
        announceList([response.status === 401 ? 'page.unavailable' : 'page.load_failed']);
        return;
      }
      const result = await response.json() as EventPage;
      if (request !== loadSequence.current) return;
      setPage(result);
      announceList(result.items.length === 0 ? ['page.empty'] : ['recommendation.ai_off']);
    } catch {
      if (request === loadSequence.current) announceList(['page.load_failed']);
    } finally {
      if (request === loadSequence.current) setLoading(false);
    }
  }, [announceList]);

  useEffect(() => {
    const shellLocale = document.querySelector<HTMLElement>('.ss-app')?.dataset.locale;
    setLocale(shellLocale === 'es' ? 'es' : 'en');
    setReady(true);
    announceList(['page.loading'], true);
    void load();
    return () => { loadSequence.current += 1; };
  }, [announceList, load]);

  async function act(eventId: string, action: 'rsvp' | 'waitlist' | 'cancel') {
    setBusy(true);
    announceInteraction([`action.${action === 'rsvp' ? 'rsvp' : action === 'waitlist' ? 'waitlist' : 'cancel'}`], true);
    try {
      const endpoint = `/api/v1/events/${eventId}/${action === 'waitlist' ? 'waitlist' : 'rsvp'}`;
      const response = await fetch(endpoint, { method: action === 'cancel' ? 'DELETE' : 'POST' });
      await load();
      if (response.status === 409 && action === 'rsvp') announceInteraction(['attendance.full', 'attendance.waitlist']);
      else if (!response.ok) announceInteraction(['action.failed']);
      else if (action === 'cancel') announceInteraction(['action.cancelled']);
      else if (action === 'waitlist') announceInteraction(['status.waitlisted']);
      else announceInteraction(['action.joined', 'action.reminder']);
    } catch {
      announceInteraction(['action.failed']);
    } finally {
      setBusy(false);
    }
  }

  async function propose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    announceInteraction(['proposal.send'], true);
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const title = form.get('title');
    const startsAt = form.get('starts_at');
    const note = form.get('note');
    const timeZone = form.get('time_zone');
    if (typeof title !== 'string' || typeof startsAt !== 'string' || typeof note !== 'string' || typeof timeZone !== 'string') {
      announceInteraction(['proposal.invalid']); setBusy(false); return;
    }
    let proposedAt: string;
    try { proposedAt = zonedLocalDateTimeToIso(startsAt, timeZone); }
    catch { announceInteraction(['proposal.invalid_date']); setBusy(false); return; }
    try {
      const response = await fetch('/api/v1/event-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, starts_at: proposedAt, time_zone: timeZone, note }),
      });
      announceInteraction([response.ok ? 'proposal.sent' : 'proposal.failed']);
      if (response.ok) formElement.reset();
    } catch {
      announceInteraction(['proposal.failed']);
    } finally {
      setBusy(false);
    }
  }

  const heading = message('page.heading');
  const pageAffordances = createAffordanceGroup(`${instanceId}-page-affordance`, [heading, ...noticeMessages]);
  const proposal = {
    heading: message('proposal.heading'), title: message('proposal.title'), startsAt: message('proposal.starts_at'),
    timeZone: message('proposal.timezone'), timeZoneExample: message('proposal.timezone_example'), note: message('proposal.note'),
    send: message('proposal.send'), help: message('proposal.help'),
  };
  const proposalAffordances = createAffordanceGroup(`${instanceId}-proposal-affordance`, Object.values(proposal));

  return <section aria-busy={!ready} aria-labelledby={ready ? 'events-heading' : undefined}
    data-events-loading={loading ? '' : undefined} data-events-locale-pending={ready ? undefined : ''} data-events-page>
    <p aria-atomic="true" aria-live="polite" role="status">
      {noticeMessages.map((value, index) => <Fragment
        key={`${value.found ? value.key : value.fallbackReason}-${activeNotice.revision}`}>
        <ResolvedText describedBy={pageAffordances.describedBy(value)} value={value}
          text={activeNotice.progress ? progressText(value.text) : value.text} />
        {index < noticeMessages.length - 1 ? ' ' : null}
      </Fragment>)}
    </p>
    {!ready ? null : <>
    <h1 id="events-heading"><ResolvedText describedBy={pageAffordances.describedBy(heading)} value={heading} /></h1>
    <AffordanceNotices group={pageAffordances} />
    <div className="ss-card-grid">
      {page.items.map(item => {
        const remaining = item.capacity === null ? null : Math.max(0, item.capacity - item.rsvp_count);
        const capacityMessages = remaining === null
          ? []
          : remaining === 0
            ? [message('attendance.full'), message('attendance.waitlist')]
            : [message('attendance.open')];
        const accessibility = message('accessibility.label');
        const rsvp = message('action.rsvp');
        const waitlist = message('action.waitlist');
        const cancel = message('action.cancel');
        const cardAffordances = createAffordanceGroup(`${instanceId}-event-${item.id}-affordance`, [
          ...capacityMessages, ...(item.accessibility.length > 0 ? [accessibility] : []), rsvp, waitlist, cancel,
        ]);
        return <article className="ss-card" key={item.id}>
          <h2>{item.title}</h2>
          <p><time dateTime={item.starts_at}>{formatEventDateTime(item.starts_at, item.time_zone, locale === 'es' ? 'es-US' : 'en-US')}</time></p>
          <p>{item.location}</p>
          {capacityMessages.map(value => <p key={value.found ? value.key : value.fallbackReason}>
            <ResolvedText describedBy={cardAffordances.describedBy(value)} value={value}
              text={value.found && value.key === 'attendance.open' && remaining !== null
                ? interpolateCount(value.text, remaining) : value.text} />
          </p>)}
          {item.accessibility.length > 0 && <p>
            <ResolvedText describedBy={cardAffordances.describedBy(accessibility)} value={accessibility} />: {item.accessibility.join(', ')}
          </p>}
          <p>{page.reasons?.[item.id] ?? ''}</p>
          <div className="ss-action-row" style={actionRowStyle}>
            <button aria-describedby={cardAffordances.describedBy(rsvp)} aria-label={rsvp.text}
              disabled={busy} onClick={() => void act(item.id, 'rsvp')}>
              <ResolvedText describedBy={cardAffordances.describedBy(rsvp)} value={rsvp} />
            </button>
            <button aria-describedby={cardAffordances.describedBy(waitlist)} aria-label={waitlist.text}
              disabled={busy} onClick={() => void act(item.id, 'waitlist')}>
              <ResolvedText describedBy={cardAffordances.describedBy(waitlist)} value={waitlist} />
            </button>
            <button aria-describedby={cardAffordances.describedBy(cancel)} aria-label={cancel.text}
              disabled={busy} onClick={() => void act(item.id, 'cancel')}>
              <ResolvedText describedBy={cardAffordances.describedBy(cancel)} value={cancel} />
            </button>
          </div>
          <AffordanceNotices group={cardAffordances} />
        </article>;
      })}
    </div>
    <form aria-describedby={proposalAffordances.describedBy(proposal.heading)} className="ss-card"
      onSubmit={event => void propose(event)} style={flowStyle}>
      <h2><ResolvedText describedBy={proposalAffordances.describedBy(proposal.heading)} value={proposal.heading} /></h2>
      <label style={flowStyle}>
        <ResolvedText describedBy={proposalAffordances.describedBy(proposal.title)} value={proposal.title} />
        <input aria-describedby={proposalAffordances.describedBy(proposal.title)} aria-label={proposal.title.text}
          name="title" required maxLength={200} style={controlStyle} />
      </label>
      <label style={flowStyle}>
        <ResolvedText describedBy={proposalAffordances.describedBy(proposal.startsAt)} value={proposal.startsAt} />
        <input aria-describedby={proposalAffordances.describedBy(proposal.startsAt)} aria-label={proposal.startsAt.text}
          name="starts_at" required style={controlStyle} type="datetime-local" />
      </label>
      <label style={flowStyle}>
        <ResolvedText describedBy={proposalAffordances.describedBy(proposal.timeZone)} value={proposal.timeZone} />
        <select aria-describedby={proposalAffordances.describedBy(proposal.timeZoneExample)} aria-label={proposal.timeZone.text}
          name="time_zone" defaultValue="America/New_York" style={controlStyle} {...focusProps}>
          <option lang={proposal.timeZoneExample.renderedLocale ?? undefined} value="America/New_York">{proposal.timeZoneExample.text}</option>
        </select>
      </label>
      <label style={flowStyle}>
        <ResolvedText describedBy={proposalAffordances.describedBy(proposal.note)} value={proposal.note} />
        <textarea aria-describedby={proposalAffordances.describedBy(proposal.note)} aria-label={proposal.note.text}
          name="note" maxLength={4000} style={noteStyle} {...focusProps} />
      </label>
      <button aria-describedby={proposalAffordances.describedBy(proposal.send)} aria-label={proposal.send.text}
        disabled={busy} type="submit">
        <ResolvedText describedBy={proposalAffordances.describedBy(proposal.send)} value={proposal.send} />
      </button>
      <AffordanceNotices group={proposalAffordances} />
    </form>
    <p><a aria-describedby={proposalAffordances.describedBy(proposal.help)} href="/help">
      <ResolvedText describedBy={proposalAffordances.describedBy(proposal.help)} value={proposal.help} />
    </a></p>
    </>}
  </section>;
}

export default function EventsPage() {
  return <EventsContent />;
}
