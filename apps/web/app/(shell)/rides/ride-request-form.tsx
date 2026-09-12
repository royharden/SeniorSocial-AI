'use client';

import {
  resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution,
} from '@seniorsocial/i18n/catalogs';
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

type Locale = 'en' | 'es';
type NoticeKey =
  | 'request.none'
  | 'request.saving'
  | 'request.pickup_invalid'
  | 'request.send_failed'
  | 'request.sent_unconfirmed'
  | 'request.saved_unsent';

const access = [
  ['wheelchair', 'accessibility.wheelchair'],
  ['walker', 'accessibility.walker'],
  ['needs_an_arm', 'accessibility.needs_an_arm'],
  ['service_animal', 'accessibility.service_animal'],
  ['oxygen', 'accessibility.oxygen'],
  ['door_to_door', 'accessibility.door_to_door'],
] as const;

const formStyle: CSSProperties = { display: 'grid', gap: 'var(--ss-target-gap)', maxWidth: '100%' };
const labelStyle: CSSProperties = { display: 'grid', gap: '0.375rem', maxWidth: '100%' };
const checkLabelStyle: CSSProperties = {
  alignItems: 'center', cursor: 'pointer', display: 'flex', gap: '0.75rem', minHeight: 'var(--ss-target)',
};
const controlStyle: CSSProperties = {
  background: 'var(--ss-surface)', border: 'var(--ss-control-width) solid var(--ss-control-border)',
  borderRadius: 'var(--ss-radius)', color: 'var(--ss-text)', font: 'inherit', minHeight: 'var(--ss-target)',
  minWidth: 0, padding: '0.5rem 0.75rem', width: '100%',
};
const focusStyle: CSSProperties = {
  boxShadow: '0 0 0 0.125rem var(--ss-focus-inner)',
  outline: '0.1875rem solid var(--ss-focus-outer)', outlineOffset: '0.375rem',
};
const fieldsetStyle: CSSProperties = {
  border: 0, display: 'grid', gap: 'var(--ss-target-gap)', margin: 0, minWidth: 0, padding: 0,
};
const checkboxStyle: CSSProperties = { flex: '0 0 auto', inlineSize: '1.5rem', margin: 0, minHeight: '1.5rem' };

function message(locale: Locale, key: CatalogMessageRequest<'rides'>['key']): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'rides', key });
}

export function CatalogText({ value }: { readonly value: CatalogResolution }) {
  const catalogKey = `${value.namespace}.${value.key}`;
  return <>
    <span
      data-catalog-fallback-reason={value.fallbackReason ?? undefined}
      data-catalog-key={catalogKey}
      data-catalog-render-state={value.renderState}
      lang={value.renderedLocale ?? undefined}
    >
      {value.text}
    </span>
    {value.affordance
      ? <small data-catalog-affordance={value.renderState} data-catalog-key={catalogKey} lang="en"> {value.affordance}</small>
      : null}
  </>;
}

export function CatalogOption({ value, optionValue }: {
  readonly value: CatalogResolution;
  readonly optionValue: string;
}) {
  const catalogKey = `${value.namespace}.${value.key}`;
  return <option
    data-catalog-affordance={value.affordance ? value.renderState : undefined}
    data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={catalogKey}
    data-catalog-render-state={value.renderState}
    lang={value.renderedLocale ?? undefined}
    value={optionValue}
  >
    {value.text}{value.affordance ? ` — ${value.affordance}` : null}
  </option>;
}

export function RideRequestForm({ idempotencyKey, locale }: {
  readonly idempotencyKey: string;
  readonly locale: Locale;
}) {
  const [hydrated, setHydrated] = useState(false);
  const [pending, setPending] = useState(false);
  const [focusedControl, setFocusedControl] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ readonly key: NoticeKey; readonly revision: number } | null>(null);
  const disabled = !hydrated || pending;

  useEffect(() => { setHydrated(true); }, []);

  function announce(key: NoticeKey) {
    setNotice(current => ({ key, revision: (current?.revision ?? 0) + 1 }));
  }

  function focusableStyle(id: string): CSSProperties {
    return focusedControl === id ? { ...controlStyle, ...focusStyle } : controlStyle;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || pending) return;
    const form = new FormData(event.currentTarget);
    const pickup = form.get('pickup_at');
    const pickupDate = typeof pickup === 'string' ? new Date(pickup) : null;
    if (pickupDate === null || Number.isNaN(pickupDate.valueOf())) {
      announce('request.pickup_invalid');
      return;
    }
    const selected = access
      .filter(([code]) => form.getAll('accessibility').includes(code))
      .map(([code, key]) => ({ code, label: message(locale, key).text }));
    setPending(true);
    announce('request.saving');
    try {
      const response = await fetch('/api/v1/rides', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ purpose: form.get('purpose'), mode: form.get('mode'), pickup_at: pickupDate.toISOString(),
          pickup_tz: Intl.DateTimeFormat().resolvedOptions().timeZone, pickup_location: form.get('pickup_location'),
          destination_location: form.get('destination_location'), return_needed: form.get('return_needed') === 'on',
          accessibility_details: selected }),
      });
      if (!response.ok) { announce('request.send_failed'); return; }
      const ride = await response.json() as { state: string; send_state: string };
      announce(ride.send_state === 'sent' ? 'request.sent_unconfirmed' : 'request.saved_unsent');
    } catch {
      announce('request.send_failed');
    } finally {
      setPending(false);
    }
  }

  const option = (value: string, key: CatalogMessageRequest<'rides'>['key']) => {
    const resolved = message(locale, key);
    return <CatalogOption key={value} optionValue={value} value={resolved} />;
  };

  const focusProps = (id: string) => ({
    onBlur: () => { setFocusedControl(current => current === id ? null : current); },
    onFocus: () => { setFocusedControl(id); },
    style: focusableStyle(id),
  });

  return (
    <form aria-busy={pending} className="ss-card" data-ride-request-form onSubmit={event => { void submit(event); }} style={formStyle}>
      <label htmlFor="ride-purpose" style={labelStyle}>
        <CatalogText value={message(locale, 'purpose.label')} />
        <select {...focusProps('ride-purpose')} disabled={disabled} id="ride-purpose" name="purpose" required defaultValue="medical">
          {option('medical', 'purpose.medical')}
          {option('groceries', 'purpose.grocery')}
          {option('community', 'purpose.community')}
        </select>
      </label>
      <label htmlFor="ride-mode" style={labelStyle}>
        <CatalogText value={message(locale, 'mode.label')} />
        <select {...focusProps('ride-mode')} disabled={disabled} id="ride-mode" name="mode" required defaultValue="partner_van">
          {option('partner_van', 'mode.partner_van')}
          {option('paratransit', 'mode.paratransit')}
          {option('taxi_voucher', 'mode.taxi_voucher')}
          {option('rideshare', 'mode.rideshare')}
        </select>
      </label>
      <label htmlFor="ride-pickup-at" style={labelStyle}>
        <CatalogText value={message(locale, 'pickup.time')} />
        <input {...focusProps('ride-pickup-at')} disabled={disabled} id="ride-pickup-at" name="pickup_at" type="datetime-local" required />
      </label>
      <label htmlFor="ride-pickup-place" style={labelStyle}>
        <CatalogText value={message(locale, 'pickup.place')} />
        <select {...focusProps('ride-pickup-place')} disabled={disabled} id="ride-pickup-place" name="pickup_location" required defaultValue="home">
          {option('home', 'pickup.home')}
          {option('community_center', 'pickup.other')}
        </select>
      </label>
      <label htmlFor="ride-destination" style={labelStyle}>
        <CatalogText value={message(locale, 'destination.label')} />
        <select {...focusProps('ride-destination')} disabled={disabled} id="ride-destination" name="destination_location" required defaultValue="clinic">
          {option('clinic', 'destination.medical')}
          {option('grocery_store', 'destination.grocery')}
          {option('community_center', 'destination.community')}
          {option('somewhere_else', 'destination.other')}
        </select>
      </label>
      <fieldset style={fieldsetStyle}>
        <legend><CatalogText value={message(locale, 'accessibility.legend')} /></legend>
        {access.map(([code, key]) => <label key={code} style={checkLabelStyle}>
          <input disabled={disabled} name="accessibility" style={checkboxStyle} type="checkbox" value={code} />
          <CatalogText value={message(locale, key)} />
        </label>)}
      </fieldset>
      <label style={checkLabelStyle}>
        <input disabled={disabled} name="return_needed" style={checkboxStyle} type="checkbox" />
        <CatalogText value={message(locale, 'return.label')} />
      </label>
      <button className="ss-primary-action" disabled={disabled} type="submit">
        <CatalogText value={message(locale, 'request.send')} />
      </button>
      {notice === null ? <p data-ride-initial-state><CatalogText value={message(locale, 'request.none')} /></p> : null}
      <p aria-atomic="true" aria-live="polite" role="status">
        {notice === null ? null : <span key={notice.revision}><CatalogText value={message(locale, notice.key)} /></span>}
      </p>
    </form>
  );
}
