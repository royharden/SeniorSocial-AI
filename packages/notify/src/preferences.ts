import { schemas, type Preferences } from '@seniorsocial/contracts';

export const channels = ['email', 'sms', 'voice'] as const;
export type Channel = (typeof channels)[number];
export const purposes = ['task_notice', 'urgent_assistance', 'event_reminder', 'message', 'forums_digest', 'recommendations'] as const;
export type Purpose = (typeof purposes)[number];
export type Choices = Partial<Record<Purpose, Partial<Record<Channel, boolean>>>>;
export interface NotifyPreferences extends Preferences { channels: Choices }

export function parsePreferences(input: unknown): NotifyPreferences {
  const parsed = schemas.Preferences.parse(input);
  const choices: Choices = {};
  for (const [purpose, value] of Object.entries(parsed.channels)) {
    if (!purposes.includes(purpose as Purpose) || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid preferences');
    const selection: Partial<Record<Channel, boolean>> = {};
    for (const [channel, allowed] of Object.entries(value)) {
      if (!channels.includes(channel as Channel) || typeof allowed !== 'boolean') throw new Error('Invalid preferences');
      selection[channel as Channel] = allowed;
    }
    choices[purpose as Purpose] = selection;
  }
  const quiet = parsed.quiet_hours;
  if (Object.keys(quiet).length > 0) {
    if (Object.keys(quiet).some(key => !['start', 'end', 'timezone'].includes(key)) ||
      typeof quiet.start !== 'string' || typeof quiet.end !== 'string' || typeof quiet.timezone !== 'string' ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end) || quiet.start === quiet.end) throw new Error('Invalid quiet hours');
    // Validate against the runtime's IANA timezone database, never a fixed UTC offset.
    new Intl.DateTimeFormat('en-US', { timeZone: quiet.timezone }).format(new Date(0));
  }
  return { ...parsed, channels: choices };
}

export const defaultPreferences = (): NotifyPreferences => ({ mode: 'standard', locale: 'en', channels: {}, quiet_hours: {}, no_outbound: true, shared_device: false });

/** Replacement of the supplied purpose/channel selections; omission preserves prior choices.
 * Only explicit purpose-specific values can turn a previous refusal back on.
 */
export function replacePreferences(previous: NotifyPreferences, input: unknown): NotifyPreferences {
  const next = parsePreferences(input);
  const merged = structuredClone(previous.channels);
  for (const purpose of purposes) {
    if (next.channels[purpose]) merged[purpose] = { ...merged[purpose], ...next.channels[purpose] };
  }
  return { ...next, channels: merged };
}

export function permits(preferences: NotifyPreferences, purpose: Purpose, channel: Channel): boolean {
  return !preferences.no_outbound && preferences.channels[purpose]?.[channel] === true;
}

export function nextDeliveryAt(now: Date, preferences: NotifyPreferences, purpose: Purpose): Date {
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid clock');
  const { start, end, timezone } = preferences.quiet_hours;
  if (purpose === 'urgent_assistance' || !start || !end || !timezone) return new Date(now);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const quiet = (instant: Date) => {
    const local = formatter.format(instant);
    return start < end ? local >= start && local < end : local >= start || local < end;
  };
  if (!quiet(now)) return new Date(now);
  // Walk real instants to find the next allowed minute. Skipped and repeated civil
  // times at DST transitions need no guessing or nonexistent-local-time coercion.
  let instant = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 48 * 60; minute++, instant += 60_000) {
    const candidate = new Date(instant);
    if (!quiet(candidate)) return candidate;
  }
  throw new Error('Quiet window has no reachable end');
}
