export function validTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 100) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date(0)); return true; } catch { return false; }
}

export function formatEventDateTime(startsAt: string, timeZone: string, locale = 'en-US'): string {
  if (!validTimeZone(timeZone) || !Number.isFinite(Date.parse(startsAt))) throw new Error('Invalid event instant or time zone');
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short' }).format(new Date(startsAt));
}

/** Converts an HTML datetime-local wall time using the selected IANA zone.
 * Nonexistent spring-forward times are rejected instead of silently shifted.
 */
export function zonedLocalDateTimeToIso(local: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local);
  if (!match || !validTimeZone(timeZone)) throw new Error('Invalid local event time');
  const year = Number(match[1] ?? Number.NaN);
  const month = Number(match[2] ?? Number.NaN);
  const day = Number(match[3] ?? Number.NaN);
  const hour = Number(match[4] ?? Number.NaN);
  const minute = Number(match[5] ?? Number.NaN);
  if (![year, month, day, hour, minute].every(Number.isInteger)) throw new Error('Invalid local event time');
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = target;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let attempt = 0; attempt < 4; attempt++) {
    const values = Object.fromEntries(formatter.formatToParts(new Date(candidate)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
    const represented = Date.UTC(requiredPart(values, 'year'), requiredPart(values, 'month') - 1, requiredPart(values, 'day'), requiredPart(values, 'hour'), requiredPart(values, 'minute'));
    candidate += target - represented;
  }
  const check = formatter.formatToParts(new Date(candidate));
  const normalized = Object.fromEntries(check.filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  if (normalized.year !== year || normalized.month !== month || normalized.day !== day || normalized.hour !== hour || normalized.minute !== minute) throw new Error('Local event time does not exist in this time zone');
  return new Date(candidate).toISOString();
}

function requiredPart(values: Record<string, unknown>, name: string): number {
  const value = values[name];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Unable to resolve local event time');
  return value;
}
