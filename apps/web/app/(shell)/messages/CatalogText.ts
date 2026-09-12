import { createElement, Fragment } from 'react';
import type { CatalogResolution } from '@seniorsocial/i18n/catalogs';

function token(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'value';
}

export function qualifiedCatalogKey(resolution: CatalogResolution) {
  return `${resolution.namespace}.${resolution.key}`;
}

export function hasCatalogAffordance(resolution: CatalogResolution) {
  return resolution.affordance !== null;
}

export function catalogNoticeId(resolution: CatalogResolution, instance: string) {
  return `messages-${token(instance)}-${token(resolution.key)}-notice`;
}

export function catalogDescribedBy(resolution: CatalogResolution, noticeId: string) {
  return hasCatalogAffordance(resolution) ? noticeId : undefined;
}

export function mergeDescribedBy(...values: Array<string | undefined>) {
  const tokens = [...new Set(values.flatMap(value => value?.split(/\s+/u).filter(Boolean) ?? []))];
  return tokens.length === 0 ? undefined : tokens.join(' ');
}

export function ResolvedText({ resolution }: { readonly resolution: CatalogResolution }) {
  return createElement('span', {
    lang: resolution.renderedLocale ?? undefined,
    'data-catalog-key': qualifiedCatalogKey(resolution),
    'data-catalog-render-state': resolution.renderState,
  }, resolution.text);
}

export function CatalogAffordance({ resolution, id }: {
  readonly resolution: CatalogResolution;
  readonly id: string;
}) {
  // Fail-safe metadata states can return no affordance. Preserve that
  // contract rather than claiming a translation's review status locally.
  if (!hasCatalogAffordance(resolution)) return null;
  return createElement('span', {
    id,
    lang: 'en',
    'data-catalog-key': qualifiedCatalogKey(resolution),
    'data-catalog-affordance': resolution.renderState,
  }, resolution.affordance);
}

export function CatalogText({ resolution, noticeId }: {
  readonly resolution: CatalogResolution;
  readonly noticeId: string;
}) {
  return createElement(
    Fragment,
    null,
    createElement(ResolvedText, { resolution }),
    !hasCatalogAffordance(resolution)
      ? null
      : createElement(Fragment, null, ' ', createElement(CatalogAffordance, { resolution, id: noticeId })),
  );
}
