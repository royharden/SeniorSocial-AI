import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface HeaderPolicy {
  scope: string;
  always: Record<string, string | { source: string; requirements: string[] }>;
  conditional: Record<string, { environment: string; value: string }>;
}

const policy = JSON.parse(readFileSync(
  new URL('../../../infra/headers/security-policy.json', import.meta.url), 'utf8',
)) as HeaderPolicy;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function configuredHeaders(enableHsts: boolean) {
  vi.stubEnv('ENABLE_HSTS', enableHsts ? 'true' : 'false');
  vi.resetModules();
  const config = (await import('../../../apps/web/next.config.ts')).default;
  const entries = await config.headers?.();
  expect(entries).toHaveLength(1);
  return Object.fromEntries((entries?.[0]?.headers ?? []).map(header => [header.key, header.value]));
}

describe('WP-033 security-header policy', () => {
  it('emits framing, MIME-sniffing and referrer protections on every path', async () => {
    const headers = await configuredHeaders(false);
    expect(policy.scope).toBe('/:path*');
    for (const [name, expected] of Object.entries(policy.always)) {
      if (typeof expected === 'string') expect(headers[name]).toBe(expected);
    }
  });

  it('emits HSTS only when the deployment explicitly declares TLS termination', async () => {
    const expected = policy.conditional['Strict-Transport-Security'];
    expect((await configuredHeaders(false))['Strict-Transport-Security']).toBeUndefined();
    expect((await configuredHeaders(true))['Strict-Transport-Security']).toBe(expected?.value);
  });

  it('keeps a nonce-bearing CSP on both the forwarded request and response', () => {
    const source = readFileSync(new URL('../../../apps/web/proxy.ts', import.meta.url), 'utf8');
    const csp = policy.always['Content-Security-Policy'];
    expect(typeof csp).toBe('object');
    for (const requirement of typeof csp === 'object' ? csp.requirements : []) {
      expect(source).toContain(`"${requirement}"`);
    }
    expect(source).toContain("`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'");
    expect(source).toContain("requestHeaders.set('Content-Security-Policy', csp)");
    expect(source).toContain("response.headers.set('Content-Security-Policy', csp)");
    expect(source).toContain("source: '/((?!_next/static|_next/image|favicon.ico).*)'");
    expect(source).not.toMatch(/source:\s*['"][^'"\n]*\(\?![^\n]*\bapi\b/u);
  });
});
