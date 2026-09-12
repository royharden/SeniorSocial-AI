import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
import {resolveCatalogMessage} from '../../../packages/i18n/src/catalogs';

const root=resolve(import.meta.dirname,'../../..');
const component=resolve(root,'apps/web/app/services/page.tsx');
const keys=['directory.heading','directory.intro','directory.search_label','directory.search_placeholder','directory.search_action','directory.no_results','directory.error','directory.eligibility','directory.source_updated'] as const;

describe('WP-032 services fallback association',()=>{
  it('routes every visible directory message through approval-aware catalog metadata',async()=>{
    // what_bug_this_catches: a fallback remaining visible while its provenance and render state disappear from the DOM.
    const source=await readFile(component,'utf8');
    for(const key of keys)expect(source).toContain(`'${key}'`);
    expect(source).toContain('data-catalog-key={`${value.namespace}.${value.key}`}');
    expect(source).toContain('data-catalog-render-state={value.renderState}');
    expect(source).toContain('data-catalog-fallback-reason={value.fallbackReason ?? undefined}');
    expect(source).not.toContain('data-catalog-message=');
  });

  it('associates fallback headings, controls, and messages with stable token-safe notice ids',async()=>{
    // what_bug_this_catches: an English fallback notice being visually present but unreachable to assistive technology, duplicated across results, or emitted as an invalid multi-token id.
    const source=await readFile(component,'utf8');
    expect(source).toContain("value.key.replaceAll('.','-')");
    expect(source).toContain("String(instance).replaceAll(/[^A-Za-z0-9_-]/gu,'-')");
    expect(source).toContain("tokens.join(' ')");
    expect(source).toContain('<h1 aria-describedby={describedBy(heading)}');
    expect(source).toContain('<p aria-describedby={describedBy(intro)}');
    expect(source).toContain('<label aria-describedby={describedBy(searchLabel)} htmlFor="service-query">');
    expect(source).toContain('aria-describedby={descriptions(describedBy(searchLabel),describedBy(searchPlaceholder))}');
    expect(source).toContain('<button aria-describedby={describedBy(searchAction)}');
    expect(source).toContain('<p aria-describedby={describedBy(error)} role="alert">');
    expect(source).toContain('<p aria-describedby={describedBy(noResults)}>');
    expect(source).toContain('describedBy(eligibilityValue,index)');
    expect(source).toContain('describedBy(sourceValue,index)');
    expect(source).toContain('<Affordance instance={index} value={eligibilityValue} />');
    expect(source).toContain('<Affordance instance={index} value={sourceValue} />');
  });

  it('keeps affordance text outside accessible control names and preserves label association',async()=>{
    // what_bug_this_catches: translation-state text becoming part of the search field or button accessible name.
    const source=await readFile(component,'utf8');
    expect(source).toContain('htmlFor="service-query"');expect(source).toContain('id="service-query"');
    expect(source).toContain('aria-label={searchLabel.text}');expect(source).toContain('placeholder={searchPlaceholder.text}');
    expect(source).toMatch(/<\/button>\s*<Affordance value=\{searchAction\}/u);
    expect(source).toMatch(/<\/label>\s*<Affordance value=\{searchLabel\}/u);
    expect(source).not.toMatch(/<button[^>]*>[\s\S]*?<Affordance value=\{searchAction\}[\s\S]*?<\/button>/u);
    expect(source).not.toMatch(/<label[^>]*>[\s\S]*?<Affordance value=\{searchLabel\}[\s\S]*?<\/label>/u);
  });

  it('emits fallback descriptions only when the resolver supplies an affordance',()=>{
    // what_bug_this_catches: approved Spanish or English source copy retaining stale fallback descriptions.
    for(const key of keys){const spanish=resolveCatalogMessage({locale:'es',namespace:'services',key});expect(spanish).toMatchObject({found:true,renderState:'provisional_english_fallback',renderedLocale:'en',fallbackReason:'provisional_translation',affordance:'Spanish translation is awaiting review.'});const english=resolveCatalogMessage({locale:'en',namespace:'services',key});expect(english).toMatchObject({found:true,renderState:'english_source',renderedLocale:'en',fallbackReason:null,affordance:null});}
  });

  it('preserves search navigation, query bounds, data rendering, and error behavior',async()=>{
    // what_bug_this_catches: an accessibility-only edit changing the server query or directory results contract.
    const source=await readFile(component,'utf8');
    expect(source).toContain('action="/services"');expect(source).toContain('method="get"');expect(source).toContain('name="q"');
    expect(source).toContain('{ query, locale, limit: 20 }');expect(source).toContain('items.map((item,index)');
    expect(source).toContain('role="alert"');expect(source).toContain('aria-live="polite"');
    expect(source).toContain('href={`tel:${item.phone}`}');expect(source).not.toContain('dangerouslySetInnerHTML');
  });
});
