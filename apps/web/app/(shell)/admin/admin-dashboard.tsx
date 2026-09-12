'use client';

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import {
  resolveCatalogMessage, type CatalogKey, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { loadQueue, queueDefinitions } from '../../../../../packages/admin/src/queue.ts';
import type { AnalyticsTiles, Page, QueueItem, QueueKind, QueueTransport } from '../../../../../packages/admin/src/types.ts';
import styles from './admin.module.css';

type Locale = 'en' | 'es';
type AdminKey = CatalogKey<'admin'>;
export type AdminMessageResolver = (request: CatalogMessageRequest<'admin'>) => CatalogResolution;

const queueKeys = {
  assistance: 'queue.assistance', rides: 'queue.rides', moderation: 'queue.moderation', translation: 'queue.translation',
} as const satisfies Record<QueueKind, AdminKey>;
const stateKeys = {
  active: 'state.active', held_for_review: 'state.held_for_review', pending_unowned: 'state.pending_unowned',
  owned: 'state.owned', in_progress: 'state.in_progress', resolved: 'state.resolved', closed_unable: 'state.closed_unable',
  waiting_for_dispatcher: 'state.waiting_for_dispatcher', confirmed_by: 'state.confirmed_by', completed: 'state.completed',
  cancelled: 'state.cancelled', unable_to_fulfill: 'state.unable_to_fulfill', awaiting_review: 'state.awaiting_review',
  keep: 'state.keep', remove: 'state.remove', warn: 'state.warn', draft: 'state.draft', approved: 'state.approved',
  invalidated: 'state.invalidated',
} as const satisfies Readonly<Record<string, AdminKey>>;
const itemKeys = {
  food: 'item.food', housing: 'item.housing', transportation: 'item.transportation', social_support: 'item.social_support',
  general: 'item.general', immediate_safety: 'item.immediate_safety', post: 'item.post', reply: 'item.reply', message: 'item.message',
} as const satisfies Readonly<Record<string, AdminKey>>;
const analyticsKeys = {
  users: 'analytics.users', managed_content: 'analytics.managed_content', partners: 'analytics.partners', review_holds: 'analytics.review_holds',
} as const satisfies Readonly<Record<string, AdminKey>>;
const roleKeys = {
  senior: 'role.senior', caregiver: 'role.caregiver', staff: 'role.staff', partner: 'role.partner', support: 'role.support', admin: 'role.admin',
} as const satisfies Readonly<Record<string, AdminKey>>;

const transport: QueueTransport = {
  async get(endpoint: string) {
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) throw new Error('queue');
    return response.json() as Promise<unknown>;
  },
};

const translationStatuses = new Set(['draft', 'awaiting_review', 'approved', 'invalidated']);
const translationQueueLimit = 100;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const rfc3339Pattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('translation queue');
  return value as Record<string, unknown>;
}

function requiredString(row: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = row[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || (pattern && !pattern.test(value))) {
    throw new Error('translation queue');
  }
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('translation queue');
  return value;
}

function rfc3339DateTime(row: Record<string, unknown>, key: string): string {
  const value = requiredString(row, key);
  const match = rfc3339Pattern.exec(value);
  if (!match) throw new Error('translation queue');
  const number = (index: number) => Number(match[index]);
  const year = number(1); const month = number(2); const day = number(3); const hour = number(4);
  const minute = number(5); const second = number(6); const offsetHour = number(7); const offsetMinute = number(8);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59
    || offsetHour > 23 || offsetMinute > 59) throw new Error('translation queue');
  return value;
}

export function translationReviewQueue(value: unknown): Page<QueueItem> {
  const page = object(value);
  if (!Array.isArray(page.items) || page.items.length > translationQueueLimit) throw new Error('translation queue');
  const matches: QueueItem[] = [];
  let draftCount = 0;
  for (const candidate of page.items) {
    const view = object(candidate);
    const source = object(view.source);
    const sourceId = requiredString(source, 'id', uuidPattern);
    const key = requiredString(source, 'key');
    const currentSourceVersion = positiveInteger(source.version);
    if (!Array.isArray(view.history) || view.history.length > translationQueueLimit) throw new Error('translation queue');
    for (const candidateDraft of view.history) {
      draftCount += 1;
      if (draftCount > translationQueueLimit) throw new Error('translation queue');
      const draft = object(candidateDraft);
      const status = requiredString(draft, 'status');
      if (!translationStatuses.has(status)) throw new Error('translation queue');
      const draftId = requiredString(draft, 'id', uuidPattern);
      const sourceVersion = positiveInteger(draft.sourceVersion);
      if (requiredString(draft, 'sourceId', uuidPattern) !== sourceId
        || sourceVersion > currentSourceVersion) throw new Error('translation queue');
      requiredString(draft, 'createdBy', uuidPattern);
      rfc3339DateTime(draft, 'createdAt');
      if (status !== 'awaiting_review') continue;
      if (sourceVersion !== currentSourceVersion) throw new Error('translation queue');
      matches.push({
        id: draftId,
        queue: 'translation',
        label: key,
        state: status,
        actor: null,
        at: null,
      });
    }
  }
  if (matches.length > translationQueueLimit) throw new Error('translation queue');
  return { items: matches, meta: { next_cursor: null, total_known: true } };
}

async function loadDashboardQueue(current: QueueKind): Promise<Page<QueueItem>> {
  if (current !== 'translation') return loadQueue(transport, current);
  return translationReviewQueue(await transport.get(queueDefinitions.translation.endpoint));
}

function message(resolveMessage: AdminMessageResolver, locale: Locale, key: AdminKey) {
  return resolveMessage({ locale, namespace: 'admin', key });
}

function mappedMessage(
  resolveMessage: AdminMessageResolver, locale: Locale, value: string,
  keys: Readonly<Record<string, AdminKey>>,
): CatalogResolution | null {
  const key = keys[value];
  return key ? message(resolveMessage, locale, key) : null;
}

interface Notice { readonly affordance: string; readonly id: string; readonly renderState: CatalogResolution['renderState'] }
function noticeGroup(scope: string, values: readonly (CatalogResolution | null)[]) {
  const notices: Notice[] = [];
  for (const value of values) {
    if (!value?.affordance) continue;
    if (notices.some(notice => notice.affordance === value.affordance && notice.renderState === value.renderState)) continue;
    notices.push({ affordance: value.affordance, id: `${scope}-translation-${notices.length + 1}`, renderState: value.renderState });
  }
  return {
    describedBy(value: CatalogResolution | null) {
      if (!value?.affordance) return undefined;
      return notices.find(notice => notice.affordance === value.affordance && notice.renderState === value.renderState)?.id;
    },
    notices,
  };
}

function CatalogText({ describedBy, value }: { readonly describedBy?: string | undefined; readonly value: CatalogResolution }) {
  return <span aria-describedby={value.affordance ? describedBy : undefined}
    data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    lang={value.renderedLocale ?? undefined}>{value.text}</span>;
}

function Notices({ values }: { readonly values: readonly Notice[] }) {
  return values.map(value => <small data-catalog-affordance={value.renderState} id={value.id} key={value.id} lang="en">{value.affordance}</small>);
}

function ResolvedOrRaw({ describedBy, raw, value }: {
  readonly describedBy?: string | undefined; readonly raw: string; readonly value: CatalogResolution | null;
}) {
  return value ? <CatalogText describedBy={describedBy} value={value} /> : <span data-admin-unknown-value="">{raw}</span>;
}

function QueueSection({ kind, locale, resolveMessage }: {
  readonly kind: QueueKind; readonly locale: Locale; readonly resolveMessage: AdminMessageResolver;
}) {
  const [state, setState] = useState<{ items: QueueItem[]; error: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    loadDashboardQueue(kind).then(result => { if (live) setState({ items: result.items, error: false }); })
      .catch(() => { if (live) setState({ items: [], error: true }); });
    return () => { live = false; };
  }, [kind]);
  const name = message(resolveMessage, locale, queueKeys[kind]);
  const status = !state ? message(resolveMessage, locale, 'status.loading')
    : state.error ? message(resolveMessage, locale, 'status.load_failed')
      : state.items.length === 0 ? message(resolveMessage, locale, 'status.empty') : null;
  const itemCopy = state?.items.flatMap(item => [
    item.label ? mappedMessage(resolveMessage, locale, item.label, itemKeys) : name,
    mappedMessage(resolveMessage, locale, item.state, stateKeys),
  ]) ?? [];
  const notices = noticeGroup(`queue-${kind}`, [name, status, ...itemCopy]);
  return <section className={styles.panel} aria-labelledby={`queue-${kind}`}>
    <h3 id={`queue-${kind}`}><CatalogText describedBy={notices.describedBy(name)} value={name} /></h3>
    {status ? <p role={state?.error ? 'alert' : state ? undefined : 'status'}><CatalogText describedBy={notices.describedBy(status)} value={status} /></p> : null}
    {state && !state.error && state.items.length > 0 ? <ul>{state.items.map(item => {
      const label = item.label ? mappedMessage(resolveMessage, locale, item.label, itemKeys) : name;
      const itemState = mappedMessage(resolveMessage, locale, item.state, stateKeys);
      return <li key={item.id}>
        <strong><ResolvedOrRaw describedBy={notices.describedBy(label)} raw={item.label ?? name.text} value={label} /></strong>
        <ResolvedOrRaw describedBy={notices.describedBy(itemState)} raw={item.state} value={itemState} />
        {item.actor && item.at ? <small>{item.actor} · <time dateTime={item.at}>{new Date(item.at).toLocaleString(locale)}</time></small> : null}
      </li>;
    })}</ul> : null}
    <Notices values={notices.notices} />
  </section>;
}

interface UserRow { id: string; display_name: string; account_state: string; roles: string[]; version: number }
function Users({ locale, resolveMessage }: { readonly locale: Locale; readonly resolveMessage: AdminMessageResolver }) {
  const [items, setItems] = useState<UserRow[] | null>(null);
  const [messageKey, setMessageKey] = useState<'status.loading' | 'status.load_failed' | 'status.saved' | null>(null);
  const refresh = useCallback(() => fetch('/api/v1/admin/users', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error();
    return response.json() as Promise<Page<UserRow>>;
  }).then(page => setItems(page.items)).catch(() => setMessageKey('status.load_failed')), []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function toggle(user: UserRow) {
    setMessageKey('status.loading');
    const accountState = user.account_state === 'held_for_review' ? 'active' : 'held_for_review';
    const response = await fetch(`/api/v1/admin/users/${user.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_state: accountState, expected_version: user.version }),
    });
    if (response.ok) { setMessageKey('status.saved'); await refresh(); } else setMessageKey('status.load_failed');
  }
  const heading = message(resolveMessage, locale, 'section.users');
  const feedback = messageKey ? message(resolveMessage, locale, messageKey) : null;
  const loading = items === null ? message(resolveMessage, locale, 'status.loading') : null;
  const empty = items?.length === 0 ? message(resolveMessage, locale, 'status.empty') : null;
  const rows = items?.map(user => ({ user,
    action: message(resolveMessage, locale, user.account_state === 'held_for_review' ? 'action.account_release' : 'action.account_hold'),
    accountState: mappedMessage(resolveMessage, locale, user.account_state, stateKeys),
    roles: user.roles.map(role => ({ raw: role, value: mappedMessage(resolveMessage, locale, role, roleKeys) })),
  })) ?? [];
  const notices = noticeGroup('admin-users', [heading, feedback, loading, empty,
    ...rows.flatMap(row => [row.action, row.accountState, ...row.roles.map(role => role.value)])]);
  return <section aria-labelledby="users-heading">
    <h2 id="users-heading"><CatalogText describedBy={notices.describedBy(heading)} value={heading} /></h2>
    <p aria-live="polite" role="status">{feedback ? <CatalogText describedBy={notices.describedBy(feedback)} value={feedback} /> : null}</p>
    {loading ? <p><CatalogText describedBy={notices.describedBy(loading)} value={loading} /></p> : null}
    {empty ? <p><CatalogText describedBy={notices.describedBy(empty)} value={empty} /></p> : null}
    {rows.length > 0 ? <ul className={styles.cards}>{rows.map(row => <li className={styles.panel} key={row.user.id}>
      <strong>{row.user.display_name}</strong><span>{row.roles.map((role, index) => <span key={`${role.raw}-${index}`}>
        {index > 0 ? ', ' : null}<ResolvedOrRaw describedBy={notices.describedBy(role.value)} raw={role.raw} value={role.value} />
      </span>)}</span>
      <ResolvedOrRaw describedBy={notices.describedBy(row.accountState)} raw={row.user.account_state} value={row.accountState} />
      <button aria-describedby={notices.describedBy(row.action)} type="button" onClick={() => { void toggle(row.user); }}><CatalogText value={row.action} /></button>
    </li>)}</ul> : null}
    <Notices values={notices.notices} />
  </section>;
}

const managers = [
  { key: 'content-pages', label: 'manager.content_pages', fields: [['slug', 'field.slug', 'text']] },
  { key: 'faqs', label: 'manager.faqs', fields: [['question', 'field.question', 'text'], ['answer', 'field.answer', 'text']] },
  { key: 'announcements', label: 'manager.announcements', fields: [['title', 'field.title', 'text'], ['publish_at', 'field.publish_at', 'datetime-local']] },
  { key: 'partners', label: 'manager.partners', fields: [['name', 'field.name', 'text'], ['contact', 'field.contact', 'text']] },
] as const satisfies readonly { readonly key: string; readonly label: AdminKey; readonly fields: readonly (readonly [string, AdminKey, string])[] }[];

function recordLabel(item: Record<string, unknown>): string | null {
  for (const key of ['slug', 'question', 'title', 'name']) {
    const value = item[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function ContentManagers({ locale, resolveMessage }: { readonly locale: Locale; readonly resolveMessage: AdminMessageResolver }) {
  const [messageKey, setMessageKey] = useState<'status.loading' | 'status.load_failed' | 'status.saved' | null>(null);
  const [items, setItems] = useState<Record<string, Record<string, unknown>[]>>({});
  const refresh = useCallback(async (key: string) => {
    const response = await fetch(`/api/v1/admin/${key}`, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result = await response.json() as Page<Record<string, unknown>>;
    setItems(current => ({ ...current, [key]: result.items }));
  }, []);
  useEffect(() => { for (const manager of managers) void refresh(manager.key).catch(() => setMessageKey('status.load_failed')); }, [refresh]);
  async function submit(event: FormEvent<HTMLFormElement>, key: string) {
    event.preventDefault(); setMessageKey('status.loading');
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    if (key === 'announcements' && typeof values.publish_at === 'string') values.publish_at = new Date(values.publish_at).toISOString();
    const response = await fetch(`/api/v1/admin/${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(values),
    });
    if (response.ok) { form.reset(); await refresh(key); setMessageKey('status.saved'); } else setMessageKey('status.load_failed');
  }
  const heading = message(resolveMessage, locale, 'section.content');
  const feedback = messageKey ? message(resolveMessage, locale, messageKey) : null;
  const create = message(resolveMessage, locale, 'action.create');
  const records = message(resolveMessage, locale, 'records.label');
  const savedFallback = message(resolveMessage, locale, 'records.saved_fallback');
  const managerCopy = managers.map(manager => ({ ...manager, title: message(resolveMessage, locale, manager.label),
    fields: manager.fields.map(([name, key, type]) => ({ name, type, value: message(resolveMessage, locale, key) })),
  }));
  const notices = noticeGroup('admin-content', [heading, feedback, create, records, savedFallback,
    ...managerCopy.flatMap(manager => [manager.title, ...manager.fields.map(field => field.value)])]);
  return <section aria-labelledby="content-heading">
    <h2 id="content-heading"><CatalogText describedBy={notices.describedBy(heading)} value={heading} /></h2>
    <p aria-live="polite" role="status">{feedback ? <CatalogText describedBy={notices.describedBy(feedback)} value={feedback} /> : null}</p>
    <div className={styles.grid}>{managerCopy.map(manager => <form className={styles.panel} key={manager.key} onSubmit={event => { void submit(event, manager.key); }}>
      <h3><CatalogText describedBy={notices.describedBy(manager.title)} value={manager.title} /></h3>
      {manager.fields.map(field => <label key={field.name}><CatalogText describedBy={notices.describedBy(field.value)} value={field.value} />
        <input aria-describedby={notices.describedBy(field.value)} name={field.name} type={field.type} required /></label>)}
      <button aria-describedby={notices.describedBy(create)}><CatalogText value={create} /></button>
      <ul aria-describedby={notices.describedBy(records)} aria-label={`${manager.title.text} ${records.text}`}>
        {(items[manager.key] ?? []).map((item, index) => { const label = recordLabel(item); return <li key={typeof item.id === 'string' ? item.id : index}>
          {label ?? <CatalogText describedBy={notices.describedBy(savedFallback)} value={savedFallback} />}</li>; })}
      </ul>
    </form>)}</div><Notices values={notices.notices} />
  </section>;
}

function Analytics({ locale, resolveMessage }: { readonly locale: Locale; readonly resolveMessage: AdminMessageResolver }) {
  const [tiles, setTiles] = useState<AnalyticsTiles | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { fetch('/api/v1/admin/analytics', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error(); return response.json() as Promise<AnalyticsTiles>;
  }).then(setTiles).catch(() => setFailed(true)); }, []);
  const heading = message(resolveMessage, locale, 'section.analytics');
  const status = failed ? message(resolveMessage, locale, 'status.load_failed') : tiles === null ? message(resolveMessage, locale, 'status.loading') : null;
  const rows = tiles?.tiles.map(tile => ({ tile, label: mappedMessage(resolveMessage, locale, tile.key, analyticsKeys) })) ?? [];
  const notices = noticeGroup('admin-analytics', [heading, status, ...rows.map(row => row.label)]);
  return <section aria-labelledby="analytics-heading"><h2 id="analytics-heading"><CatalogText describedBy={notices.describedBy(heading)} value={heading} /></h2>
    {status ? <p role={failed ? 'alert' : 'status'}><CatalogText describedBy={notices.describedBy(status)} value={status} /></p> : null}
    {rows.length > 0 ? <dl className={styles.grid}>{rows.map(row => <div className={styles.panel} key={row.tile.key}>
      <dt><ResolvedOrRaw describedBy={notices.describedBy(row.label)} raw={row.tile.key} value={row.label} /></dt>
      <dd>{row.tile.value}</dd><small>{row.tile.unit_definition} {row.tile.known_gap}</small></div>)}</dl> : null}
    <Notices values={notices.notices} /></section>;
}

function SectionHeading({ children, describedBy, id, value }: {
  readonly children: ReactNode; readonly describedBy?: string | undefined; readonly id: string; readonly value: CatalogResolution;
}) {
  return <section aria-labelledby={id}><h2 id={id}><CatalogText describedBy={describedBy} value={value} /></h2>{children}</section>;
}

export function AdminDashboardContent({ locale, resolveMessage = resolveCatalogMessage }: {
  readonly locale: Locale; readonly resolveMessage?: AdminMessageResolver;
}) {
  const title = message(resolveMessage, locale, 'page.title');
  const intro = message(resolveMessage, locale, 'page.intro');
  const queues = message(resolveMessage, locale, 'section.queues');
  const headerNotices = noticeGroup('admin-header', [title, intro]);
  const queueNotices = noticeGroup('admin-queues', [queues]);
  return <div className={styles.main} data-admin-locale={locale}><header><div>
    <h1><CatalogText describedBy={headerNotices.describedBy(title)} value={title} /></h1>
    <p><CatalogText describedBy={headerNotices.describedBy(intro)} value={intro} /></p>
  </div><Notices values={headerNotices.notices} /></header>
  <SectionHeading describedBy={queueNotices.describedBy(queues)} id="queues-heading" value={queues}>
    <div className={styles.grid}>{(Object.keys(queueKeys) as QueueKind[]).map(kind =>
      <QueueSection kind={kind} locale={locale} key={kind} resolveMessage={resolveMessage} />)}</div>
    <Notices values={queueNotices.notices} />
  </SectionHeading>
  <Users locale={locale} resolveMessage={resolveMessage} />
  <ContentManagers locale={locale} resolveMessage={resolveMessage} />
  <Analytics locale={locale} resolveMessage={resolveMessage} /></div>;
}

export function AdminDashboard() {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(() => { setLocale(document.querySelector<HTMLElement>('.ss-app')?.dataset.locale === 'es' ? 'es' : 'en'); }, []);
  return locale ? <AdminDashboardContent locale={locale} /> : <div aria-busy="true" className={styles.main} data-admin-locale-pending="" />;
}
