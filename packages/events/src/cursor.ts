import type { EventCursor } from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function encodeEventCursor(cursor: EventCursor): string {
  return Buffer.from(JSON.stringify([cursor.startsAt, cursor.id]), 'utf8').toString('base64url');
}

export function decodeEventCursor(value: string | undefined): EventCursor | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string' ||
      !Number.isFinite(Date.parse(parsed[0])) || !uuid.test(parsed[1])) return null;
    return { startsAt: new Date(parsed[0]).toISOString(), id: parsed[1] };
  } catch { return null; }
}
