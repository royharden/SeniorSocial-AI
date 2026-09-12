import type { CatalogResolution } from '@seniorsocial/i18n/catalogs';

export function CatalogText({ value }: { readonly value: CatalogResolution }) {
  const renderedLocale = value.renderedLocale ?? undefined;
  const catalogKey = `${value.namespace}.${value.key}`;

  return <>
    <span
      data-catalog-key={catalogKey}
      data-catalog-render-state={value.renderState}
      data-catalog-fallback-reason={value.fallbackReason ?? undefined}
      lang={renderedLocale}
    >
      {value.text}
    </span>
    {value.affordance
      ? <small data-catalog-affordance={value.renderState} data-catalog-key={catalogKey} lang="en"> {value.affordance}</small>
      : null}
  </>;
}
