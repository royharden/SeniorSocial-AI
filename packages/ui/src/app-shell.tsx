import type { ReactNode } from 'react';
import { catalogs, resolveCatalogMessage, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import type { DisplayMode, SupportedLocale } from './preferences';

const copy = {
  en: { home: catalogs.en.shell.home, settings: catalogs.en.shell.settings, mainNavigation: catalogs.en.shell.main_navigation, consistentHelp: catalogs.en.shell.consistent_help, help: catalogs.en.shell.help_me, call: catalogs.en.shell.call_person, provisional: '' },
  es: { home: catalogs.es.shell.home, settings: catalogs.es.shell.settings, mainNavigation: catalogs.es.shell.main_navigation, consistentHelp: catalogs.es.shell.consistent_help, help: catalogs.es.shell.help_me, call: catalogs.es.shell.call_person, provisional: catalogs.es.common.translation_draft },
} as const;

interface PreferenceProps { readonly locale: SupportedLocale; readonly mode: DisplayMode }

function ChoiceButton({ active, detail, label, name, value }: { readonly active: boolean; readonly detail?: ReactNode; readonly label: ReactNode; readonly name: string; readonly value: string }) {
  return <button aria-pressed={active} className="ss-choice" name={name} type="submit" value={value}><strong>{label}</strong>{detail ? <small>{detail}</small> : null}</button>;
}

const profileKeys = ['display_question', 'regular', 'regular_detail', 'easy', 'easy_detail', 'current_choice', 'change_anytime', 'language', 'english', 'spanish'] as const;
type ProfileKey = (typeof profileKeys)[number];
export type ProfileMessageResolver = (input: { readonly locale: SupportedLocale; readonly namespace: 'profile'; readonly key: ProfileKey }) => CatalogResolution;

function profileCopy(locale: SupportedLocale, resolveMessage: ProfileMessageResolver) {
  return Object.fromEntries(profileKeys.map(key => [key, resolveMessage({ locale, namespace: 'profile', key })])) as Record<ProfileKey, CatalogResolution>;
}

function CatalogText({ value }: { readonly value: CatalogResolution }) {
  return <span lang={value.renderedLocale ?? undefined} data-catalog-key={value.key} data-catalog-render-state={value.renderState}>{value.text}</span>;
}

function PreferenceControls({ locale, mode, scope, resolveMessage = resolveCatalogMessage }: PreferenceProps & { readonly scope: 'header' | 'settings'; readonly resolveMessage?: ProfileMessageResolver }) {
  const text = profileCopy(locale, resolveMessage);
  const affordances = [...new Map(Object.values(text).filter(value => value.affordance !== null).map(value => [value.affordance, value])).values()];
  const noticeId = affordances.length > 0 ? `${scope}-profile-translation-state` : undefined;
  return <div className="ss-preferences">
    <form action="/preferences/confirm" method="get"><fieldset aria-describedby={noticeId} className="ss-choice-group"><legend><CatalogText value={text.display_question} /></legend><ChoiceButton active={mode === 'standard'} detail={<CatalogText value={text.regular_detail} />} label={<CatalogText value={text.regular} />} name="mode" value="standard" /><ChoiceButton active={mode === 'easy'} detail={<CatalogText value={text.easy_detail} />} label={<CatalogText value={text.easy} />} name="mode" value="easy" /><small role="status"><CatalogText value={text.current_choice} />: <CatalogText value={mode === 'easy' ? text.easy : text.regular} />. <CatalogText value={text.change_anytime} /></small></fieldset></form>
    <form action="/preferences" method="post"><fieldset aria-describedby={noticeId} className="ss-choice-group ss-language-choice"><legend><CatalogText value={text.language} /></legend><ChoiceButton active={locale === 'en'} label={<CatalogText value={text.english} />} name="locale" value="en" /><ChoiceButton active={locale === 'es'} label={<CatalogText value={text.spanish} />} name="locale" value="es" /></fieldset></form>
    {affordances.length > 0 ? <p id={noticeId} className="ss-translation-state">{affordances.map((value, index) => <span key={value.key} lang="en" data-catalog-affordance={value.renderState} data-catalog-keys={profileKeys.filter(key => text[key].affordance === value.affordance).map(key => `profile.${key}`).join(' ')}>{index > 0 ? ' ' : null}{value.affordance}</span>)}</p> : null}
  </div>;
}

export function AppShell({ appName, children, locale, mode }: PreferenceProps & { readonly appName: string; readonly children: ReactNode }) {
  const text = copy[locale];
  return <div className="ss-app" data-locale={locale} data-mode={mode} lang={locale}>
    <header className="ss-header"><a className="ss-brand" href="/home">{appName}</a><nav aria-label={text.mainNavigation}><a href="/home">{text.home}</a><a href="/settings">{text.settings}</a></nav><PreferenceControls locale={locale} mode={mode} scope="header" /></header>
    <main className="ss-content" id="main" tabIndex={-1}>{text.provisional ? <p className="ss-translation-state">{text.provisional}</p> : null}{children}</main>
    {mode === 'easy' ? <nav aria-label={text.consistentHelp} className="ss-easy-bar"><a href="/help">{text.help}</a><a href="/help">{text.call}</a></nav> : null}
  </div>;
}

export function PreferenceSettings(props: PreferenceProps & { readonly resolveMessage?: ProfileMessageResolver }) {
  const resolver = props.resolveMessage ?? resolveCatalogMessage;
  const question = resolver({ locale: props.locale, namespace: 'profile', key: 'display_question' });
  return <section aria-labelledby="preference-heading" className="ss-card ss-settings"><h2 id="preference-heading"><CatalogText value={question} /></h2><PreferenceControls locale={props.locale} mode={props.mode} scope="settings" resolveMessage={resolver} /></section>;
}
