import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import { LOCALE_STORAGE_KEY, type DisplayMode } from '@seniorsocial/ui';

type Locale = 'en' | 'es';
type OwnedRequest = CatalogMessageRequest<'common'> | CatalogMessageRequest<'profile'>;
type Resolver = (request: OwnedRequest) => CatalogResolution;

function Message({ value, describedBy }: { readonly value: CatalogResolution; readonly describedBy?: string | undefined }) {
  return <span aria-describedby={value.affordance ? describedBy : undefined}
    data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    lang={value.renderedLocale ?? undefined}>{value.text}</span>;
}

function Notice({ id, value }: { readonly id: string; readonly value: CatalogResolution }) {
  return value.affordance ? <small data-catalog-affordance={value.renderState} id={id} lang="en">{value.affordance}</small> : null;
}

export function ConfirmPreferenceContent({ locale, mode, resolveMessage = resolveCatalogMessage }: {
  readonly locale: Locale; readonly mode: DisplayMode; readonly resolveMessage?: Resolver;
}) {
  const heading = resolveMessage({ locale, namespace: 'profile', key: 'confirm_heading' });
  const chosen = resolveMessage({ locale, namespace: 'profile', key: 'you_chose' });
  const confirmation = resolveMessage({ locale, namespace: 'profile', key: mode === 'easy' ? 'easy_confirmation' : 'standard_confirmation' });
  const confirm = resolveMessage({ locale, namespace: 'common', key: 'confirm' });
  const back = resolveMessage({ locale, namespace: 'common', key: 'go_back' });
  const statusNotices = [chosen, confirmation].reduce<Array<{
    readonly id: string; readonly affordance: string; readonly renderState: CatalogResolution['renderState'];
  }>>((notices, value) => {
    if (!value.affordance) return notices;
    const existing = notices.find(notice => notice.affordance === value.affordance && notice.renderState === value.renderState);
    return existing ? notices : [...notices, {
      id: `confirm-status-translation-${notices.length + 1}`, affordance: value.affordance, renderState: value.renderState,
    }];
  }, []);
  const describedBy = (value: CatalogResolution) => statusNotices.find(
    notice => notice.affordance === value.affordance && notice.renderState === value.renderState,
  )?.id;
  return <section aria-labelledby="confirm-heading" className="ss-card ss-confirmation">
    <h1 id="confirm-heading"><Message describedBy="confirm-heading-translation" value={heading} /></h1>
    <Notice id="confirm-heading-translation" value={heading} />
    <p role="status"><strong><Message describedBy={describedBy(chosen)} value={chosen} />: <Message describedBy={describedBy(confirmation)} value={confirmation} />.</strong></p>
    {statusNotices.map(notice => <small data-catalog-affordance={notice.renderState} id={notice.id} key={notice.id} lang="en">{notice.affordance}</small>)}
    <form action="/preferences" method="post">
      <input name="mode" type="hidden" value={mode} />
      <input name="confirm" type="hidden" value="yes" />
      <button aria-describedby={confirm.affordance ? 'confirm-submit-translation' : undefined} className="ss-primary-action" type="submit"><Message value={confirm} /></button>
      <Notice id="confirm-submit-translation" value={confirm} />
    </form>
    <a aria-describedby={back.affordance ? 'confirm-back-translation' : undefined} href="/settings"><Message value={back} /></a>
    <Notice id="confirm-back-translation" value={back} />
  </section>;
}

export default async function ConfirmPreferencePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly mode?: string }>;
}) {
  const { mode } = await searchParams;
  if (mode !== 'standard' && mode !== 'easy') redirect('/settings');

  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const confirmedMode: DisplayMode = mode;
  return <ConfirmPreferenceContent locale={locale} mode={confirmedMode} />;
}
