'use client';

import {
  resolveCatalogMessage, type CatalogKey, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from 'react';

type Locale = 'en' | 'es';
type GroupKey = CatalogKey<'groups'>;
type GroupMessageResolver = (input: CatalogMessageRequest<'groups'>) => CatalogResolution;

interface Topic { id: string; title: string; post_count: number }
interface Post { id: string; author_id: string; body: string; flag_state: 'none' | 'flagged_awaiting_human' | 'cleared_by_human' | 'removed_by_human' }

const groupKeys = [
  'title', 'safety_notice', 'loading_topics', 'sign_in', 'unavailable', 'choose_topic', 'no_topics',
  'topic_unavailable', 'post_visible', 'posting_rate_limited', 'post_error', 'report_sent',
  'report_error', 'reply_posted', 'reply_error', 'block_success', 'block_error', 'topics_label',
  'awaiting_review', 'report_action', 'block_action', 'reply_label', 'post_reply', 'write_post',
  'message_label', 'post_to_group', 'call_person', 'worry_suffix',
] as const satisfies readonly GroupKey[];

type GroupCopy = Readonly<Record<GroupKey, CatalogResolution>>;

type AffordanceGroup = {
  readonly notices: readonly {
    readonly id: string;
    readonly keys: readonly string[];
    readonly renderState: string;
    readonly text: string;
  }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function resolveGroupCopy(locale: Locale, resolveMessage: GroupMessageResolver): GroupCopy {
  return Object.fromEntries(groupKeys.map(key => [key, resolveMessage({ locale, namespace: 'groups', key })])) as GroupCopy;
}

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const unique = new Map<string, { keys: string[]; renderState: string }>();
  for (const value of values) {
    if (!value.found || value.affordance === null) continue;
    const existing = unique.get(value.affordance);
    const catalogKey = `${value.namespace}.${value.key}`;
    if (existing) existing.keys.push(catalogKey);
    else unique.set(value.affordance, { keys: [catalogKey], renderState: value.renderState });
  }
  const notices = [...unique].map(([text, value], index) => ({
    id: `${prefix}-${index + 1}`, keys: value.keys, renderState: value.renderState, text,
  }));
  return {
    notices,
    describedBy(value) {
      if (!value.found || value.affordance === null) return undefined;
      return notices.find(notice => notice.text === value.affordance)?.id;
    },
  };
}

export function CatalogText({ group, value }: {
  readonly group: AffordanceGroup;
  readonly value: CatalogResolution;
}) {
  if (!value.found) return null;
  return <span
    aria-describedby={group.describedBy(value)}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    data-catalog-review-status={value.reviewStatus}
    lang={value.renderedLocale ?? undefined}
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

export function GroupsContent({ initialLocale = 'en', resolveMessage = resolveCatalogMessage }: {
  readonly initialLocale?: Locale;
  readonly resolveMessage?: GroupMessageResolver;
}) {
  const instanceId = useId().replaceAll(':', '');
  const [locale, setLocale] = useState<Locale>(initialLocale);
  const [localeReady, setLocaleReady] = useState(false);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [statusKey, setStatusKey] = useState<GroupKey>('loading_topics');
  const [busy, setBusy] = useState(false);
  const copy = useMemo(() => resolveGroupCopy(locale, resolveMessage), [locale, resolveMessage]);
  const affordances = useMemo(
    () => createAffordanceGroup(`groups-i18n-${instanceId}`, groupKeys.map(key => copy[key])),
    [copy, instanceId],
  );

  useEffect(() => {
    setLocale(document.querySelector<HTMLElement>('.ss-app')?.dataset.locale === 'es' ? 'es' : 'en');
    setLocaleReady(true);
  }, []);

  const loadTopics = useCallback(async () => {
    const result = await fetch('/api/v1/forums/topics', { cache: 'no-store' });
    if (!result.ok) {
      setStatusKey(result.status === 401 ? 'sign_in' : 'unavailable');
      return;
    }
    const page = await result.json() as { items: Topic[] };
    setTopics(page.items);
    setSelected(current => current ?? page.items[0]?.id ?? null);
    setStatusKey(page.items.length ? 'choose_topic' : 'no_topics');
  }, []);

  const loadPosts = useCallback(async (topicId: string) => {
    const result = await fetch(`/api/v1/forums/topics/${topicId}/posts`, { cache: 'no-store' });
    if (!result.ok) {
      setPosts([]);
      setStatusKey('topic_unavailable');
      return;
    }
    const page = await result.json() as { items: Post[] };
    setPosts(page.items);
  }, []);

  useEffect(() => { void loadTopics(); }, [loadTopics]);
  useEffect(() => { if (selected) void loadPosts(selected); }, [selected, loadPosts]);

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    const form = event.currentTarget;
    const body = new FormData(form).get('body');
    const result = await fetch(`/api/v1/forums/topics/${selected}/posts`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    });
    if (result.ok) {
      form.reset();
      await loadPosts(selected);
      await loadTopics();
      setStatusKey('post_visible');
    } else {
      setStatusKey(result.status === 429 ? 'posting_rate_limited' : 'post_error');
    }
    setBusy(false);
  }

  async function report(postId: string) {
    const result = await fetch(`/api/v1/forums/posts/${postId}/report`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'community_safety' }),
    });
    setStatusKey(result.ok ? 'report_sent' : 'report_error');
  }

  async function reply(event: FormEvent<HTMLFormElement>, postId: string) {
    event.preventDefault();
    setBusy(true);
    const form = event.currentTarget;
    const body = new FormData(form).get('body');
    const result = await fetch(`/api/v1/forums/posts/${postId}/replies`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }),
    });
    setStatusKey(result.ok ? 'reply_posted' : 'reply_error');
    if (result.ok) form.reset();
    setBusy(false);
  }

  async function block(userId: string) {
    const result = await fetch('/api/v1/blocks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: userId }),
    });
    if (result.ok && selected) {
      await loadPosts(selected);
      await loadTopics();
      setStatusKey('block_success');
    } else {
      setStatusKey(result.ok ? 'block_success' : 'block_error');
    }
  }

  return <section
    aria-labelledby="groups-heading"
    data-groups-locale-pending={localeReady ? undefined : ''}
    data-groups-page
  >
    <h1 id="groups-heading"><CatalogText group={affordances} value={copy.title} /></h1>
    <p><CatalogText group={affordances} value={copy.safety_notice} /></p>
    <p aria-live="polite" role="status"><CatalogText group={affordances} value={copy[statusKey]} /></p>
    <nav
      aria-describedby={affordances.describedBy(copy.topics_label)}
      aria-label={copy.topics_label.text}
      className="ss-action-row"
      data-catalog-key="groups.topics_label"
      data-catalog-render-state={copy.topics_label.renderState}
      data-catalog-review-status={copy.topics_label.reviewStatus}
      lang={copy.topics_label.renderedLocale ?? undefined}
    >
      {topics.map(topic => <button key={topic.id} aria-pressed={selected === topic.id} onClick={() => setSelected(topic.id)}>
        {topic.title} ({topic.post_count})
      </button>)}
    </nav>
    <div className="ss-card-grid">
      {posts.map(post => <article className="ss-card" key={post.id}>
        <p>{post.body}</p>
        {post.flag_state === 'flagged_awaiting_human' && <p><CatalogText group={affordances} value={copy.awaiting_review} /></p>}
        <div className="ss-action-row">
          <button aria-describedby={affordances.describedBy(copy.report_action)} onClick={() => void report(post.id)}><CatalogText group={affordances} value={copy.report_action} /></button>
          <button aria-describedby={affordances.describedBy(copy.block_action)} onClick={() => void block(post.author_id)}><CatalogText group={affordances} value={copy.block_action} /></button>
        </div>
        <form onSubmit={event => void reply(event, post.id)}>
          <label><CatalogText group={affordances} value={copy.reply_label} /><textarea aria-describedby={affordances.describedBy(copy.reply_label)} name="body" required maxLength={8000} /></label>
          <button aria-describedby={affordances.describedBy(copy.post_reply)} disabled={busy} type="submit"><CatalogText group={affordances} value={copy.post_reply} /></button>
        </form>
      </article>)}
    </div>
    {selected && <form className="ss-card" onSubmit={event => void publish(event)}>
      <h2><CatalogText group={affordances} value={copy.write_post} /></h2>
      <label><CatalogText group={affordances} value={copy.message_label} /><textarea aria-describedby={affordances.describedBy(copy.message_label)} name="body" required maxLength={8000} /></label>
      <button aria-describedby={affordances.describedBy(copy.post_to_group)} disabled={busy} type="submit"><CatalogText group={affordances} value={copy.post_to_group} /></button>
    </form>}
    <p><a aria-describedby={affordances.describedBy(copy.call_person)} href="/help"><CatalogText group={affordances} value={copy.call_person} /></a>{' '}<CatalogText group={affordances} value={copy.worry_suffix} /></p>
    <AffordanceNotices group={affordances} />
  </section>;
}

export default function GroupsPage() {
  return <GroupsContent />;
}
