'use client';

import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

type Locale = 'en' | 'es';
type PendingAction = 'invite' | 'consent' | 'revoke';
type CaregiverMessageResolver = (input: CatalogMessageRequest<'caregiver'>) => CatalogResolution;
type NoticeKey =
  | 'invitation.created'
  | 'invitation.failed'
  | 'consent.permissions_saved'
  | 'consent.permissions_failed'
  | 'consent.revoked'
  | 'consent.revoke_failed';

const scopeKeys = [
  'view_schedule',
  'book_rides',
  'receive_alerts',
  'view_assistance',
  'view_profile',
] as const;

const formStyle: CSSProperties = { display: 'grid', gap: '0.75rem' };
const labelStyle: CSSProperties = { display: 'grid', gap: '0.375rem' };
const checkLabelStyle: CSSProperties = { alignItems: 'center', display: 'flex', gap: '0.75rem', minHeight: 'var(--ss-target)' };
const inputStyle: CSSProperties = { font: 'inherit', maxWidth: '100%', padding: '0.5rem', width: '100%' };
const actionRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ss-target-gap)' };
const secondaryActionStyle: CSSProperties = { cursor: 'pointer', font: 'inherit', padding: '0.5rem 1rem' };

function CatalogText({ affordanceId, value }: {
  readonly affordanceId?: string | undefined;
  readonly value: CatalogResolution;
}) {
  if (!value.found) return null;
  return <span
    aria-describedby={value.affordance === null ? undefined : affordanceId}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale}
  >{value.text}</span>;
}

function CatalogAffordance({ id, value }: {
  readonly id: string;
  readonly value?: CatalogResolution | undefined;
}) {
  if (value?.found !== true || value.affordance === null) return null;
  return <p
    data-catalog-affordance={value.renderState}
    id={id}
    lang="en"
    role="note"
    style={{ fontSize: 'var(--ss-body-size)' }}
  >{value.affordance}</p>;
}

export function CaregiverContent({ initialLocale, resolveMessage = resolveCatalogMessage }: {
  readonly initialLocale?: Locale;
  readonly resolveMessage?: CaregiverMessageResolver;
}) {
  const [locale, setLocale] = useState<Locale>(initialLocale ?? 'en');
  const [notice, setNotice] = useState<{ readonly key: NoticeKey; readonly revision: number } | null>(null);
  const [linkId, setLinkId] = useState('');
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const disabled = !hydrated || pending !== null;

  useEffect(() => {
    if (initialLocale === undefined) {
      const shellLocale = document.querySelector<HTMLElement>('.ss-app')?.dataset.locale;
      setLocale(shellLocale === 'es' ? 'es' : 'en');
    }
    setHydrated(true);
  }, [initialLocale]);

  const message = (key: CatalogMessageRequest<'caregiver'>['key']) =>
    resolveMessage({ locale, namespace: 'caregiver', key });

  function announce(key: NoticeKey) {
    setNotice(current => ({ key, revision: (current?.revision ?? 0) + 1 }));
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setPending('invite');
    try {
      const response = await fetch('/api/v1/caregiver/invitations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email_or_phone: values.get('email_or_phone'),
          relationship_note: values.get('relationship_note') || undefined,
        }),
      });
      announce(response.ok ? 'invitation.created' : 'invitation.failed');
    } catch {
      announce('invitation.failed');
    } finally {
      setPending(null);
    }
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setPending('consent');
    try {
      const response = await fetch(`/api/v1/caregiver/links/${encodeURIComponent(linkId.trim())}/scopes`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          read_back_confirmed: values.get('read_back_confirmed') === 'on',
          scopes: scopeKeys.map(key => ({ key, granted: values.get(key) === 'on' })),
        }),
      });
      announce(response.ok ? 'consent.permissions_saved' : 'consent.permissions_failed');
    } catch {
      announce('consent.permissions_failed');
    } finally {
      setPending(null);
    }
  }

  async function revoke() {
    if (!linkId.trim()) return;
    setPending('revoke');
    try {
      const response = await fetch(`/api/v1/caregiver/links/${encodeURIComponent(linkId.trim())}`, { method: 'DELETE' });
      announce(response.ok ? 'consent.revoked' : 'consent.revoke_failed');
    } catch {
      announce('consent.revoke_failed');
    } finally {
      setPending(null);
    }
  }

  const pageTitle = message('page.title');
  const pageIntro = message('page.intro');
  const invitationHeading = message('invitation.heading');
  const invitationContactLabel = message('invitation.contact_label');
  const invitationRelationshipNote = message('invitation.relationship_note');
  const invitationSend = message('invitation.send');
  const consentHeading = message('consent.heading');
  const consentInstruction = message('consent.instruction');
  const consentLinkId = message('consent.link_id');
  const readBackLegend = message('read_back.legend');
  const readBackScopes = scopeKeys.map(key => [key, message(`read_back.${key}`)] as const);
  const residentConfirmation = message('consent.resident_confirmation');
  const consentSave = message('consent.save');
  const consentRevoke = message('consent.revoke');
  const consentBoundaries = message('consent.boundaries');
  const noticeMessage = notice ? message(notice.key) : null;
  const visibleMessages = [
    pageTitle, pageIntro, invitationHeading, invitationContactLabel, invitationRelationshipNote, invitationSend,
    consentHeading, consentInstruction, consentLinkId, readBackLegend,
    ...readBackScopes.map(([, value]) => value), residentConfirmation, consentSave, consentRevoke,
    consentBoundaries, noticeMessage,
  ].filter((value): value is CatalogResolution => value !== null);
  const ordinaryAffordance = visibleMessages.find(value => !value.critical && value.affordance !== null);
  const criticalAffordance = visibleMessages.find(value => value.critical && value.affordance !== null);
  const ordinaryAffordanceId = 'caregiver-ordinary-translation-state';
  const criticalAffordanceId = 'caregiver-critical-translation-state';
  const catalogText = (value: CatalogResolution) => <CatalogText
    affordanceId={value.affordance === null
      ? undefined
      : value.critical ? criticalAffordanceId : ordinaryAffordanceId}
    value={value}
  />;

  return <section aria-labelledby="caregiver-title" style={{ display: 'grid', gap: 'var(--ss-page-gap)' }}>
    <div>
      <h1 id="caregiver-title">{catalogText(pageTitle)}</h1>
      <p>{catalogText(pageIntro)}</p>
      <CatalogAffordance id={ordinaryAffordanceId} value={ordinaryAffordance} />
      <CatalogAffordance id={criticalAffordanceId} value={criticalAffordance} />
    </div>

    <div className="ss-card-grid">
      <section aria-labelledby="invite-title" className="ss-card">
        <h2 id="invite-title">{catalogText(invitationHeading)}</h2>
        <form aria-busy={pending === 'invite'} onSubmit={event => { void invite(event); }} style={formStyle}>
          <label htmlFor="caregiver-recipient" style={labelStyle}>
            {catalogText(invitationContactLabel)}
            <input autoComplete="email" disabled={disabled} id="caregiver-recipient" name="email_or_phone" required style={inputStyle} />
          </label>
          <label htmlFor="relationship-note" style={labelStyle}>
            {catalogText(invitationRelationshipNote)}
            <input disabled={disabled} id="relationship-note" maxLength={500} name="relationship_note" style={inputStyle} />
          </label>
          <div style={actionRowStyle}>
            <button className="ss-primary-action" disabled={disabled} type="submit">
              {catalogText(invitationSend)}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="permissions-title" className="ss-card">
        <h2 id="permissions-title">{catalogText(consentHeading)}</h2>
        <p>{catalogText(consentInstruction)}</p>
        <form aria-busy={pending === 'consent' || pending === 'revoke'} onSubmit={event => { void confirm(event); }} style={formStyle}>
          <label htmlFor="caregiver-link" style={labelStyle}>
            {catalogText(consentLinkId)}
            <input disabled={disabled} id="caregiver-link" name="link_id" required style={inputStyle}
              value={linkId} onChange={event => setLinkId(event.target.value)} />
          </label>
          <fieldset style={formStyle}>
            <legend>{catalogText(readBackLegend)}</legend>
            {readBackScopes.map(([key, value]) => <label key={key} style={checkLabelStyle}>
              <input disabled={disabled} name={key} type="checkbox" />
              {catalogText(value)}
            </label>)}
          </fieldset>
          <label style={checkLabelStyle}>
            <input disabled={disabled} name="read_back_confirmed" required type="checkbox" />
            {catalogText(residentConfirmation)}
          </label>
          <div style={actionRowStyle}>
            <button className="ss-primary-action" disabled={disabled} type="submit">
              {catalogText(consentSave)}
            </button>
            <button disabled={disabled || !linkId.trim()} onClick={() => { void revoke(); }} style={secondaryActionStyle} type="button">
              {catalogText(consentRevoke)}
            </button>
          </div>
          <p>{catalogText(consentBoundaries)}</p>
        </form>
      </section>
    </div>

    <p aria-atomic="true" aria-live="polite" role="status">
      {notice && noticeMessage ? <span key={notice.revision}>{catalogText(noticeMessage)}</span> : null}
    </p>
  </section>;
}

export default function CaregiverPage() {
  return <CaregiverContent />;
}
