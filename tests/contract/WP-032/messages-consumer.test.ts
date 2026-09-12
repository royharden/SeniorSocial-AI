import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CatalogResolution } from '../../../packages/i18n/src/catalogs';
import { resolveMessagingCopy } from '../../../apps/web/app/(shell)/messages/copy';
import {
  CatalogAffordance,
  CatalogText,
  ResolvedText,
  catalogDescribedBy,
  catalogNoticeId,
  mergeDescribedBy,
} from '../../../apps/web/app/(shell)/messages/CatalogText';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof import('react-dom/server');
const provisionalAffordance = 'Spanish translation is awaiting review.';

describe('WP-032 approval-aware messages consumer', () => {
  it('resolves every ordinary message value through governed catalog metadata', () => {
    // what_bug_this_catches: local Spanish copy bypassing review state and shipping as if it were approved.
    const english = resolveMessagingCopy('en');
    const spanish = resolveMessagingCopy('es');
    expect(Object.keys(spanish)).toEqual(Object.keys(english));
    expect(Object.keys(spanish)).toHaveLength(17);
    for (const name of Object.keys(spanish) as Array<keyof typeof spanish>) {
      expect(english[name], name).toMatchObject({
        found: true,
        renderedLocale: 'en',
        renderState: 'english_source',
        affordance: null,
      });
      expect(spanish[name], name).toMatchObject({
        found: true,
        renderedLocale: 'en',
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: provisionalAffordance,
      });
      expect(spanish[name].text, name).toBe(english[name].text);
    }
  });

  it('renders fallback text with the exact qualified keyed affordance', () => {
    // what_bug_this_catches: fallback text being marked English without showing the required review notice beside that exact value.
    const resolution = resolveMessagingCopy('es').title;
    const markup = renderToStaticMarkup(createElement(CatalogText, { resolution, noticeId: 'messages-title-notice' }));
    expect(markup).toBe(
      '<span lang="en" data-catalog-key="messages.page.title" data-catalog-render-state="provisional_english_fallback">Messages</span> '
      + '<span id="messages-title-notice" lang="en" data-catalog-key="messages.page.title" data-catalog-affordance="provisional_english_fallback">Spanish translation is awaiting review.</span>',
    );
  });

  it('renders exact approved Spanish without a false review notice', () => {
    // what_bug_this_catches: the consumer hardcoding fallback UI even after a qualified approval makes Spanish eligible.
    const approved: CatalogResolution = {
      found: true,
      text: 'Mensajes',
      requestedLocale: 'es',
      renderedLocale: 'es',
      namespace: 'messages',
      key: 'page.title',
      reviewStatus: 'approved',
      critical: false,
      machineGenerated: true,
      renderState: 'approved_spanish',
      fallbackReason: null,
      affordance: null,
    };
    expect(renderToStaticMarkup(createElement(CatalogText, { resolution: approved, noticeId: 'approved-notice' }))).toBe(
      '<span lang="es" data-catalog-key="messages.page.title" data-catalog-render-state="approved_spanish">Mensajes</span>',
    );
    expect(renderToStaticMarkup(createElement(CatalogText, {
      resolution: resolveMessagingCopy('en').title,
      noticeId: 'english-notice',
    })))
      .not.toContain('data-catalog-affordance');
  });

  it('creates stable token-safe notice ids and deduplicated descriptions only for fallback values', () => {
    // what_bug_this_catches: repeated values creating invalid or duplicate IDREF tokens, or approved copy retaining a stale description.
    const fallback = resolveMessagingCopy('es').conversation;
    const english = resolveMessagingCopy('en').conversation;
    const id = catalogNoticeId(fallback, 'Conversation result #2');
    expect(id).toBe('messages-conversation-result-2-conversation-label-notice');
    expect(catalogDescribedBy(fallback, id)).toBe(id);
    expect(catalogDescribedBy(english, id)).toBeUndefined();
    expect(mergeDescribedBy(id, `${id} second-notice`, undefined, 'second-notice')).toBe(
      `${id} second-notice`,
    );
  });

  it('renders initial fallback notices as unique resolvable siblings outside accessible names', () => {
    // what_bug_this_catches: a visible review notice being unreachable by description, sharing an id, or entering a heading/control/status accessible name.
    const t = resolveMessagingCopy('es');
    const titleId = catalogNoticeId(t.title, 'title');
    const statusId = catalogNoticeId(t.loading, 'status-state-loading');
    const participantId = catalogNoticeId(t.participant, 'participant-input');
    const createId = catalogNoticeId(t.create, 'create-action');
    const selectId = catalogNoticeId(t.select, 'conversation-1');
    const conversationId = catalogNoticeId(t.conversation, 'conversation-1');
    const markup = renderToStaticMarkup(createElement('section', null,
      createElement('h1', { 'aria-describedby': catalogDescribedBy(t.title, titleId) },
        createElement(ResolvedText, { resolution: t.title })),
      createElement(CatalogAffordance, { resolution: t.title, id: titleId }),
      createElement('p', { role: 'status', 'aria-describedby': catalogDescribedBy(t.loading, statusId) },
        createElement(ResolvedText, { resolution: t.loading })),
      createElement(CatalogAffordance, { resolution: t.loading, id: statusId }),
      createElement('label', null,
        createElement(ResolvedText, { resolution: t.participant }),
        createElement('input', { 'aria-describedby': catalogDescribedBy(t.participant, participantId) })),
      createElement(CatalogAffordance, { resolution: t.participant, id: participantId }),
      createElement('button', { 'aria-describedby': catalogDescribedBy(t.create, createId) },
        createElement(ResolvedText, { resolution: t.create })),
      createElement(CatalogAffordance, { resolution: t.create, id: createId }),
      createElement('button', { 'aria-describedby': mergeDescribedBy(
        catalogDescribedBy(t.select, selectId), catalogDescribedBy(t.conversation, conversationId),
      ) }, createElement(ResolvedText, { resolution: t.select }), ' ',
      createElement(ResolvedText, { resolution: t.conversation })),
      createElement(CatalogAffordance, { resolution: t.select, id: selectId }),
      createElement(CatalogAffordance, { resolution: t.conversation, id: conversationId }),
    ));
    const ids = [...markup.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
    const describedByValues = [...markup.matchAll(/\saria-describedby="([^"]+)"/gu)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const value of describedByValues) {
      const references = value.split(/\s+/u);
      expect(new Set(references).size, value).toBe(references.length);
      for (const reference of references) expect(ids, reference).toContain(reference);
    }
    expect(markup).toContain('data-catalog-key="messages.page.title"');
    expect(markup).toContain('data-catalog-key="messages.conversation.participant_label"');
    expect(markup).not.toMatch(/data-catalog-key="(?!messages\.)/u);
    expect(markup).toMatch(/<h1[^>]*aria-describedby="([^"]+)"[^>]*>[\s\S]*?<\/h1><span id="\1"/u);
    expect(markup).toMatch(/<p role="status"[^>]*aria-describedby="([^"]+)"[^>]*>[\s\S]*?<\/p><span id="\1"/u);
    expect(markup).toMatch(/<label[^>]*>[\s\S]*?<input[^>]*aria-describedby="([^"]+)"[^>]*\/><\/label><span id="\1"/u);
    expect(markup).toMatch(/<button[^>]*aria-describedby="([^"]+)"[^>]*>[\s\S]*?<\/button><span id="\1"/u);
  });

  it('retains messaging privacy, retry, stale-load, focus, and body-safety mechanics', async () => {
    // what_bug_this_catches: a copy-only migration accidentally weakening participant APIs or interaction safety.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/messages/MessagesClient.tsx'), 'utf8');
    expect(source).toContain("fetch('/api/v1/conversations'");
    expect(source).toContain("'idempotency-key': key");
    expect(source).toContain('sendAttempt.current?.text !== body');
    expect(source).toContain('reportAttempt.current?.text !== text');
    expect(source).toContain('if (current !== generation.current) return;');
    expect(source).toContain("focusNext.current === 'editor'");
    expect(source).toContain("whiteSpace: 'pre-wrap'");
    expect(source).toContain('{message.body}');
    expect(source).not.toContain('dangerouslySetInnerHTML');
    expect(source).not.toContain('messagingCopy[locale]');
    expect(source).toContain("const instance = `conversation-${index + 1}`");
    expect(source).toContain('mergeDescribedBy(');
    expect(source).toContain("describedBy(t.back, 'selected-back')");
    expect(source).toContain("describedBy(t.refresh, 'selected-refresh')");
    expect(source).toContain("describedBy(t.body, 'message-body')");
    expect(source).toContain("describedBy(t.send, 'send-action')");
    expect(source).toContain("describedBy(critical.reportHeading, 'report-heading')");
    expect(source).toContain("describedBy(critical.reportHeading, 'report-action')");
    expect(source).toContain("describedBy(critical.reportReason, 'report-reason')");
    expect(source).toContain("describedBy(critical.reportNote, 'report-note')");
    expect(source).toContain("describedBy(critical.blockHelp, 'block-help')");
    expect(source).toContain("describedBy(critical.blockAction, 'block-action')");
    expect(source).toContain("describedBy(t.notice, 'notification-link')");
    expect(source).toMatch(/<\/button>\s*\{notice\(t\.send, 'send-action'\)\}/u);
    expect(source).toMatch(/<\/label>\s*\{notice\(critical\.reportReason, 'report-reason'\)\}/u);
  });
});
