import type { ConciergeSession } from '../../../concierge/types.ts';
import { ConciergeForbiddenError, ConciergeInputError } from '../../../concierge/types.ts';
import type { ConciergeService } from '../../../concierge/core.ts';

export interface ConciergeRouteDependencies {
  readonly authorize: (request: Request) => Promise<ConciergeSession | null>;
  readonly concierge: ConciergeService;
}

export interface RouteContext { readonly params: Promise<{ readonly conversationId: string }> }

export function problem(status: number, detail: string): Response {
  const titles: Readonly<Record<number, string>> = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 422: 'Unprocessable Content', 503: 'Service Unavailable' };
  return Response.json({ type: 'about:blank', title: titles[status] ?? 'Error', status, detail }, {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}

export async function objectBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const MAX_ZERO_LENGTH_BODY_CHUNKS = 16;
const BODY_READ_DEADLINE_MS = 1_000;

async function readBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  remainingMs: number,
): Promise<ReadableStreamReadResult<Uint8Array> | null> {
  if (signal.aborted || remainingMs <= 0) return null;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: ReadableStreamReadResult<Uint8Array> | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(result);
    };
    const aborted = () => finish(null);
    const timer = setTimeout(() => finish(null), remainingMs);
    signal.addEventListener('abort', aborted, { once: true });
    reader.read().then(finish, () => finish(null));
  });
}

export async function hasRequestPayload(request: Request): Promise<boolean> {
  if (request.body === null) return false;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return true;
  }
  try {
    const deadline = Date.now() + BODY_READ_DEADLINE_MS;
    for (let emptyChunks = 0; emptyChunks < MAX_ZERO_LENGTH_BODY_CHUNKS; emptyChunks += 1) {
      const result = await readBodyChunk(reader, request.signal, deadline - Date.now());
      if (result === null) {
        void reader.cancel().catch(() => undefined);
        return true;
      }
      if (result.done) return false;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength > 0) {
        void reader.cancel().catch(() => undefined);
        return true;
      }
    }
    void reader.cancel().catch(() => undefined);
    return true;
  } catch {
    return true;
  } finally {
    try { reader.releaseLock(); } catch { /* Treating an unreadable stream as payload remains fail-closed. */ }
  }
}

export function routeError(error: unknown): Response {
  if (error instanceof ConciergeInputError) return problem(422, error.message);
  if (error instanceof ConciergeForbiddenError) return problem(403, error.message);
  return problem(503, 'Concierge service is temporarily unavailable');
}

export function noStore(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

export function requireSameOrigin(request: Request): Response | null {
  const url = new URL(request.url);
  const expected = url.origin;
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  const fetchMode = request.headers.get('sec-fetch-mode');
  const purpose = request.headers.get('purpose') ?? request.headers.get('sec-purpose');
  return request.method === 'POST' && origin === expected && (fetchSite === null || fetchSite === 'same-origin')
    && fetchMode !== 'navigate' && purpose !== 'prefetch'
    ? null
    : problem(403, 'A same-origin deliberate POST is required');
}
