import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as ReactDOMServer from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as catalogsModule from '../../../packages/i18n/src/catalogs';
import { resolveCatalogMessage } from '../../../packages/i18n/src/catalogs';

const root = resolve(import.meta.dirname, '../../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { createElement } = requireFromWeb('react') as typeof import('react');
const { renderToStaticMarkup } = requireFromWeb('react-dom/server') as typeof ReactDOMServer;
const componentPath = resolve(root, 'apps/web/app/(shell)/groups/page.tsx');
const transpiled = ts.transpileModule(readFileSync(componentPath, 'utf8'), {
  compilerOptions: {
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: componentPath,
}).outputText;
const componentModule = { exports: {} as Record<string, unknown> };
const componentRequire = (specifier: string) => {
  if (specifier === '@seniorsocial/i18n/catalogs') return catalogsModule;
  return requireFromWeb(specifier);
};
new Function('exports', 'require', 'module', '__filename', '__dirname', transpiled)(
  componentModule.exports, componentRequire, componentModule, componentPath, resolve(componentPath, '..'),
);
const { GroupsContent } = componentModule.exports as {
  GroupsContent: (props: { readonly initialLocale?: 'en' | 'es' }) => Parameters<typeof renderToStaticMarkup>[0];
};
const criticalKeys = [
  'safety_notice', 'awaiting_review', 'report_action', 'report_sent',
  'report_error', 'block_action', 'block_success', 'block_error',
] as const;
const ordinaryKeys = ['title', 'loading_topics', 'reply_label', 'post_reply', 'write_post'] as const;

describe('WP-032 approval-aware groups consumer', () => {
  it('holds every critical draft in English and preserves resolver metadata', () => {
    // what_bug_this_catches: unreviewed fraud, moderation, report, or block instructions shipping as Spanish safety truth.
    for (const key of criticalKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'groups', key });
      const spanish = resolveCatalogMessage({ locale: 'es', namespace: 'groups', key });
      expect(spanish, key).toMatchObject({
        found: true,
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: true,
        renderState: 'held_english_fallback',
        fallbackReason: 'critical_not_approved',
        affordance: 'available in English only',
      });
    }
  });

  it('routes ordinary draft copy through the provisional English fallback', () => {
    // what_bug_this_catches: ordinary machine Spanish bypassing review or being silently displayed as approved.
    for (const key of ordinaryKeys) {
      const english = resolveCatalogMessage({ locale: 'en', namespace: 'groups', key });
      const spanish = resolveCatalogMessage({ locale: 'es', namespace: 'groups', key });
      expect(spanish, key).toMatchObject({
        found: true,
        text: english.text,
        renderedLocale: 'en',
        reviewStatus: 'draft',
        critical: false,
        renderState: 'provisional_english_fallback',
        fallbackReason: 'provisional_translation',
        affordance: 'Spanish translation is awaiting review.',
      });
    }
  });

  it('deduplicates notices and associates each rendered fallback with its exact notice', () => {
    // what_bug_this_catches: repeating a warning after every label, or rendering English fallback without an accessible association.
    const markup = renderToStaticMarkup(createElement(GroupsContent, { initialLocale: 'es' }));
    expect(markup).toContain('data-groups-locale-pending=""');
    expect(markup.match(/data-catalog-affordance="provisional_english_fallback"/gu)).toHaveLength(1);
    expect(markup.match(/data-catalog-affordance="held_english_fallback"/gu)).toHaveLength(1);
    expect(markup).toContain('data-catalog-key="groups.title"');
    expect(markup).toContain('data-catalog-render-state="provisional_english_fallback"');
    expect(markup).toContain('data-catalog-key="groups.safety_notice"');
    expect(markup).toContain('data-catalog-render-state="held_english_fallback"');

    const titleNotice = markup.match(/data-catalog-key="groups\.title"[^>]*aria-describedby="([^"]+)"/u)?.[1]
      ?? markup.match(/aria-describedby="([^"]+)"[^>]*data-catalog-key="groups\.title"/u)?.[1];
    const safetyNotice = markup.match(/data-catalog-key="groups\.safety_notice"[^>]*aria-describedby="([^"]+)"/u)?.[1]
      ?? markup.match(/aria-describedby="([^"]+)"[^>]*data-catalog-key="groups\.safety_notice"/u)?.[1];
    expect(titleNotice).toBeTruthy();
    expect(safetyNotice).toBeTruthy();
    expect(titleNotice).not.toBe(safetyNotice);
    expect(markup).toContain(`id="${titleNotice}"`);
    expect(markup).toContain(`id="${safetyNotice}"`);
    expect(markup).toContain('aria-label="Group topics"');
    expect(markup).toMatch(new RegExp(
      `<nav[^>]*aria-describedby="${titleNotice}"[^>]*data-catalog-key="groups\\.topics_label"[^>]*data-catalog-render-state="provisional_english_fallback"`,
      'u',
    ));
  });

  it('keeps forum routes, payloads, visibility language, and rate-limit behavior intact', async () => {
    // what_bug_this_catches: a localization-only migration changing the forum protocol or safety semantics.
    const source = await readFile(resolve(root, 'apps/web/app/(shell)/groups/page.tsx'), 'utf8');
    expect(source).toContain("fetch('/api/v1/forums/topics'");
    expect(source).toContain('fetch(`/api/v1/forums/topics/${selected}/posts`');
    expect(source).toContain('fetch(`/api/v1/forums/posts/${postId}/replies`');
    expect(source).toContain('fetch(`/api/v1/forums/posts/${postId}/report`');
    expect(source).toContain("fetch('/api/v1/blocks'");
    expect(source).toContain("JSON.stringify({ reason: 'community_safety' })");
    expect(source).toContain('JSON.stringify({ user_id: userId })');
    expect(source).toContain("setStatusKey(result.status === 429 ? 'posting_rate_limited' : 'post_error')");
    expect(source).toContain("post.flag_state === 'flagged_awaiting_human'");
    expect(source).toContain('{topic.title} ({topic.post_count})');
    expect(source).toContain('<p>{post.body}</p>');
    expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
