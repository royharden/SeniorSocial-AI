'use client';
import { useEffect, useId, useState } from 'react';
import { resolveCatalogMessage, type CatalogMessageRequest, type CatalogResolution } from '@seniorsocial/i18n/catalogs';
import type { NotifyPreferences } from '../../../../../../packages/notify/src/preferences';
import { channels, purposes } from '../../../../../../packages/notify/src/preferences';

type Locale = 'en' | 'es';
type NotifyKey = CatalogMessageRequest<'notify'>['key'];

function message(locale: Locale, key: NotifyKey): CatalogResolution {
  return resolveCatalogMessage({ locale, namespace: 'notify', key });
}

type AffordanceGroup = {
  readonly notices: readonly {
    readonly fallbackReason: CatalogResolution['fallbackReason'];
    readonly id: string;
    readonly keys: readonly string[];
    readonly renderState: CatalogResolution['renderState'];
    readonly text: string;
  }[];
  describedBy(value: CatalogResolution): string | undefined;
};

function noticeIdentity(value: CatalogResolution): string | null {
  if (!value.found || value.affordance === null) return null;
  return JSON.stringify([value.affordance, value.renderState, value.fallbackReason]);
}

function createAffordanceGroup(prefix: string, values: readonly CatalogResolution[]): AffordanceGroup {
  const unique = new Map<string, {
    fallbackReason: CatalogResolution['fallbackReason']; keys: string[];
    renderState: CatalogResolution['renderState']; text: string;
  }>();
  for (const value of values) {
    const identity = noticeIdentity(value);
    if (identity === null || !value.found || value.affordance === null) continue;
    const catalogKey = `${value.namespace}.${value.key}`;
    const existing = unique.get(identity);
    if (existing) {
      if (!existing.keys.includes(catalogKey)) existing.keys.push(catalogKey);
    } else {
      unique.set(identity, {
        fallbackReason: value.fallbackReason, keys: [catalogKey],
        renderState: value.renderState, text: value.affordance,
      });
    }
  }
  const notices = [...unique.values()].map((notice, index) => ({ ...notice, id: `${prefix}-${index + 1}` }));
  return {
    notices,
    describedBy(value) {
      const identity = noticeIdentity(value);
      if (identity === null) return undefined;
      const index = [...unique.keys()].indexOf(identity);
      return index < 0 ? undefined : notices[index]?.id;
    },
  };
}

function CatalogText({ group, value }: {
  readonly group: AffordanceGroup;
  readonly value: CatalogResolution;
}) {
  if (!value.found) return null;
  return <span aria-describedby={group.describedBy(value)} data-catalog-fallback-reason={value.fallbackReason ?? undefined}
    data-catalog-key={`${value.namespace}.${value.key}`} data-catalog-render-state={value.renderState}
    data-catalog-review-status={value.reviewStatus} data-render-state={value.renderState}
    data-review-status={value.reviewStatus} lang={value.renderedLocale ?? undefined}>{value.text}</span>;
}

function AffordanceNotices({ group }: { readonly group: AffordanceGroup }) {
  if (group.notices.length === 0) return null;
  return <div data-catalog-affordance-group>
    {group.notices.map(notice => <small data-catalog-affordance={notice.renderState}
      data-catalog-fallback-reason={notice.fallbackReason ?? undefined} data-catalog-keys={notice.keys.join(' ')}
      id={notice.id} key={notice.id} lang="en" role="note">{notice.text}</small>)}
  </div>;
}

export default function NotificationSettings() {
  const instanceId = useId().replaceAll(':', '');
  const [locale, setLocale] = useState<Locale>('en');
  const [localeReady, setLocaleReady] = useState(false);
  const [preferences, setPreferences] = useState<NotifyPreferences | null>(null);
  const [statusKey, setStatusKey] = useState<NotifyKey>('settings.loading');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setLocale(document.querySelector<HTMLElement>('.ss-app')?.dataset.locale === 'es' ? 'es' : 'en');
    setLocaleReady(true);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/v1/me/preferences', { cache: 'no-store', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Unavailable');
      setPreferences(await response.json() as NotifyPreferences); setStatusKey('settings.loading');
    }).catch(() => { if (!controller.signal.aborted) setStatusKey('settings.unavailable'); });
    return () => controller.abort();
  }, []);
  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/v1/me/preferences', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(preferences) });
      if (!response.ok) throw new Error('Unavailable');
      setPreferences(await response.json() as NotifyPreferences); setStatusKey('settings.saved');
    } catch { setStatusKey('settings.save_failed'); }
    finally { setSaving(false); }
  }
  const status = preferences !== null && statusKey === 'settings.loading' ? null : message(locale, statusKey);
  const title = message(locale, 'settings.title');
  const intro = message(locale, 'settings.intro');
  const deliveryHeading = message(locale, 'settings.delivery_heading');
  const noOutbound = message(locale, 'settings.no_outbound');
  const sharedDevice = message(locale, 'settings.shared_device');
  const purposeCopy = purposes.map(purpose => ({
    channels: channels.map(channel => ({ channel, value: message(locale, `channel.${channel}`) })),
    purpose,
    value: message(locale, `purpose.${purpose}`),
  }));
  const quietTitle = message(locale, 'quiet_hours.title');
  const quietIntro = message(locale, 'quiet_hours.intro');
  const quietStart = message(locale, 'quiet_hours.start');
  const quietEnd = message(locale, 'quiet_hours.end');
  const quietTimezone = message(locale, 'quiet_hours.timezone');
  const quietClear = message(locale, 'quiet_hours.clear');
  const saveLabel = message(locale, saving ? 'settings.saving' : 'settings.save');
  const printLink = message(locale, 'print.link');
  const affordances = createAffordanceGroup(`notification-translation-${instanceId}`, [
    title, intro, ...(status === null ? [] : [status]), deliveryHeading, noOutbound, sharedDevice,
    ...purposeCopy.flatMap(purpose => [purpose.value, ...purpose.channels.map(channel => channel.value)]),
    quietTitle, quietIntro, quietStart, quietEnd, quietTimezone, quietClear, saveLabel, printLink,
  ]);
  return <section aria-labelledby="notification-settings" data-notification-settings data-locale-pending={localeReady ? undefined : ''}>
    <h1 id="notification-settings"><CatalogText group={affordances} value={title} /></h1>
    <p><CatalogText group={affordances} value={intro} /></p>
    <p role="status" aria-live="polite">{status === null ? null : <CatalogText group={affordances} value={status} />}</p>
    {preferences && <form className="ss-settings" onSubmit={event => { event.preventDefault(); void save(); }}>
      <fieldset className="ss-choice-group ss-settings-choice" disabled={saving}><legend><CatalogText group={affordances} value={deliveryHeading} /></legend>
        <label><input aria-describedby={affordances.describedBy(noOutbound)} type="checkbox" checked={preferences.no_outbound} onChange={event => setPreferences({ ...preferences, no_outbound: event.target.checked })} /> <CatalogText group={affordances} value={noOutbound} /></label>
        <label><input aria-describedby={affordances.describedBy(sharedDevice)} type="checkbox" checked={preferences.shared_device} onChange={event => setPreferences({ ...preferences, shared_device: event.target.checked })} /> <CatalogText group={affordances} value={sharedDevice} /></label>
      </fieldset>
      {purposeCopy.map(({ channels: channelCopy, purpose, value }) => <fieldset className="ss-choice-group ss-settings-choice" key={purpose} disabled={saving}><legend><CatalogText group={affordances} value={value} /></legend>
        {channelCopy.map(({ channel, value: channelLabel }) => <label key={channel}><input aria-describedby={affordances.describedBy(channelLabel)} type="checkbox" checked={preferences.channels[purpose]?.[channel] === true}
          onChange={event => setPreferences({ ...preferences, channels: { ...preferences.channels, [purpose]: { ...preferences.channels[purpose], [channel]: event.target.checked } } })} /> <CatalogText group={affordances} value={channelLabel} /></label>)}
      </fieldset>)}
      <fieldset className="ss-choice-group ss-settings-choice" disabled={saving}><legend><CatalogText group={affordances} value={quietTitle} /></legend>
        <p><CatalogText group={affordances} value={quietIntro} /></p>
        <label><CatalogText group={affordances} value={quietStart} /> <input aria-describedby={affordances.describedBy(quietStart)} type="time" value={preferences.quiet_hours.start ?? ''} onChange={event => setPreferences({ ...preferences, quiet_hours: { ...preferences.quiet_hours, start: event.target.value } })} /></label>
        <label><CatalogText group={affordances} value={quietEnd} /> <input aria-describedby={affordances.describedBy(quietEnd)} type="time" value={preferences.quiet_hours.end ?? ''} onChange={event => setPreferences({ ...preferences, quiet_hours: { ...preferences.quiet_hours, end: event.target.value } })} /></label>
        <label><CatalogText group={affordances} value={quietTimezone} /> <input aria-describedby={affordances.describedBy(quietTimezone)} value={preferences.quiet_hours.timezone ?? ''} placeholder="America/New_York" onChange={event => setPreferences({ ...preferences, quiet_hours: { ...preferences.quiet_hours, timezone: event.target.value } })} /></label>
        <button aria-describedby={affordances.describedBy(quietClear)} type="button" onClick={() => setPreferences({ ...preferences, quiet_hours: {} })}><CatalogText group={affordances} value={quietClear} /></button>
      </fieldset>
      <button aria-describedby={affordances.describedBy(saveLabel)} className="ss-primary-action" type="submit" disabled={saving}><CatalogText group={affordances} value={saveLabel} /></button>
    </form>}
    <p><a aria-describedby={affordances.describedBy(printLink)} href="/print"><CatalogText group={affordances} value={printLink} /></a></p>
    <AffordanceNotices group={affordances} />
  </section>;
}
