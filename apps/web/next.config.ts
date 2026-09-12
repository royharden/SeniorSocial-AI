import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

/**
 * SEC-057 / SEC-059 / T-4. Security headers are set here, in one place, so that
 * "every response carries them" is a property of the app rather than of whichever
 * route the author remembered.
 *
 * HSTS is emitted only when ENABLE_HSTS is true, which is false locally and true
 * in any TLS-terminated environment. Sending HSTS from http://localhost pins a
 * developer's browser to https for months.
 */
const enableHsts = process.env.ENABLE_HSTS === 'true';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ...(enableHsts
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  // The runtime image copies only the traced bundle (infra/docker/Dockerfile).
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@seniorsocial/ai', '@seniorsocial/config', '@seniorsocial/i18n', '@seniorsocial/ui'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
