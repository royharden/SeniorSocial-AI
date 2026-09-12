import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const root = resolve(import.meta.dirname, '../../..');
const apiRoot = resolve(root, 'apps/web/app/api/v1');
const mutationPattern = /export\s+(?:async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/gu;
const routeParameter = '33333333-3333-4333-8333-333333333333';

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? routeFiles(path) : entry.name === 'route.ts' ? [path] : [];
  });
}

const mutations = routeFiles(apiRoot).flatMap(file => {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(mutationPattern)].map(match => ({ file, method: match[1] as 'POST' | 'PUT' | 'PATCH' | 'DELETE' }));
});

function requestUrl(file: string): string {
  const route = relative(apiRoot, file)
    .split(sep).slice(0, -1)
    .map(segment => /^\[[^\]]+\]$/u.test(segment) ? routeParameter : segment)
    .join('/');
  return `http://localhost/api/v1/${route}`;
}

const context = { params: Promise.resolve({
  conversationId: routeParameter,
  entryId: routeParameter,
  eventId: routeParameter,
  exportId: routeParameter,
  flagKey: 'concierge',
  itemId: routeParameter,
  linkId: routeParameter,
  notificationId: routeParameter,
  postId: routeParameter,
  requestId: routeParameter,
  serviceId: routeParameter,
  submissionId: routeParameter,
  token: 'missing-session-token',
  topicId: routeParameter,
  userId: routeParameter,
}) };
type RouteContext = typeof context;

describe('WP-033 direct mutation authentication', () => {
  beforeAll(() => {
    vi.stubEnv('SENIORSOCIAL_ORG_ID', '11111111-1111-4111-8111-111111111111');
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('discovers every current versioned API mutation', () => {
    expect(mutations.length).toBeGreaterThan(20);
    expect(new Set(mutations.map(item => item.method))).toEqual(new Set(['POST', 'PUT', 'PATCH', 'DELETE']));
  });

  it.each(mutations)('$method $file rejects a request with no authenticated session', async ({ file, method }) => {
    // what_bug_this_catches: a newly added state-changing route validates or executes
    // user input before the authentication-by-default boundary is reached.
    const route = await import(pathToFileURL(file).href) as Record<string, unknown>;
    const handler = route[method];
    expect(handler, `${method} export missing from ${file}`).toBeTypeOf('function');
    const request = new Request(requestUrl(file), {
      method,
      headers: { 'content-type': 'application/json' },
      ...(method === 'DELETE' ? {} : { body: '{}' }),
    });
    const response = await (handler as (request: Request, routeContext: RouteContext) => Promise<Response>)(request, context);
    expect([401, 403, 404], `${method} ${request.url} must reject at the authentication boundary`).toContain(response.status);
    expect(response.headers.get('location'), `${method} ${request.url}`).toBeNull();
    expect(response.headers.get('set-cookie'), `${method} ${request.url}`).toBeNull();
  }, 15_000);
});
