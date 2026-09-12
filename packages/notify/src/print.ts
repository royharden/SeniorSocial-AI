import { schemas, type PrintableSchedule } from '@seniorsocial/contracts';
import {
  resolveCatalogMessage,
  type CatalogMessageRequest,
  type CatalogResolution,
  type SupportedCatalogLocale,
} from '../../i18n/src/catalogs.ts';

const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
interface SourceState { key:string; status:string; source_version:string|null; as_of:string|null; item_count:number }

function sourceState(value: unknown): SourceState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Partial<SourceState>;
  return typeof source.key === 'string' && typeof source.status === 'string' &&
    (typeof source.source_version === 'string' || source.source_version === null) &&
    (typeof source.as_of === 'string' || source.as_of === null) && typeof source.item_count === 'number' ? source as SourceState : null;
}

type NotifyKey = CatalogMessageRequest<'notify'>['key'];

function message(locale: SupportedCatalogLocale, key: NotifyKey): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'notify', key });
}

function catalogHtml(value: CatalogResolution, replacements: Readonly<Record<string, string>> = {}): string {
  if (!value.found || value.renderedLocale === null) throw new Error('Print catalog unavailable');
  const text = Object.entries(replacements).reduce((result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement), value.text);
  const provenance = `data-catalog-key="${escape(`notify.${value.key}`)}" data-render-state="${escape(value.renderState)}" data-review-status="${escape(value.reviewStatus)}"`;
  const affordance = value.affordance === null ? ''
    : `<small data-catalog-affordance="${escape(value.renderState)}" lang="en"> ${escape(value.affordance)}</small>`;
  return `<span ${provenance} lang="${escape(value.renderedLocale)}">${escape(text)}</span>${affordance}`;
}

/** Render a governed snapshot. Locale must come from trusted request/session state. */
export function printableHtml(input: PrintableSchedule, locale: SupportedCatalogLocale = 'en'): string {
  const snapshot = schemas.PrintableSchedule.parse(input);
  const title = message(locale, 'print.title');
  if (!title.found || title.renderedLocale === null) throw new Error('Print catalog unavailable');
  const sourceStates = Array.isArray(snapshot.sources) ? (snapshot.sources as unknown[]).flatMap(source => sourceState(source) ?? []) : [];
  const availability = snapshot.source_version.startsWith('schedule:no-connected-sources:')
    ? `<p>${catalogHtml(message(locale, 'print.no_source'))}</p>`
    : sourceStates.length > 0 ? `<section aria-label="${escape(message(locale, 'print.source_version').text)}"><ul>${sourceStates.map(source =>
      `<li lang="en">${escape(source.key)}: ${escape(source.status)}${source.source_version ? ` (${escape(source.source_version)})` : ''}</li>`).join('')}</ul><p lang="en">Missing or unavailable sources are not evidence that you have no plans in those services.</p></section>` : '';
  const items = snapshot.items.length ? `<ol>${snapshot.items.map(item => `<li><dl>${Object.entries(item).map(([key,value]) => `<dt>${escape(key.replaceAll('_',' '))}</dt><dd>${escape(typeof value === 'string' ? value : JSON.stringify(value))}</dd>`).join('')}</dl></li>`).join('')}</ol>`
    : `<p>${catalogHtml(message(locale, 'print.empty'))}</p>`;
  return `<!doctype html><html lang="${escape(title.renderedLocale)}" data-requested-locale="${escape(locale)}" data-render-state="${escape(title.renderState)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="schedule-source-version" content="${escape(snapshot.source_version)}"><meta name="schedule-source-as-of" content="${escape(snapshot.as_of)}"><title>${escape(title.text)}</title><style>body{font:22px/1.6 system-ui;max-width:48rem;margin:2rem auto;padding:1rem;color:#111;background:#fff}li{break-inside:avoid;margin:1rem 0}dt{font-weight:bold}dd{margin-left:1rem;overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}}</style></head><body><main><h1>${catalogHtml(title)}</h1><p>${catalogHtml(message(locale, 'print.source_version'))}: <span lang="en">${escape(snapshot.source_version)}</span></p><p>${catalogHtml(message(locale, 'print.as_of'), { date: snapshot.as_of })}</p>${availability}<p>${catalogHtml(message(locale, 'print.snapshot_warning'))}</p>${items}</main></body></html>`;
}
