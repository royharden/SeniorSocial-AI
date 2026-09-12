import { loadConfig } from '@seniorsocial/config';

/**
 * GET /api/v1/health — the liveness endpoint every Compose healthcheck and the
 * runtime image's HEALTHCHECK call (WP-001, ownership.csv).
 *
 * It reports only what it can prove about the process itself. It deliberately
 * does NOT check the database: a health endpoint that fails because a dependency
 * is slow makes the orchestrator restart a perfectly healthy web process, and
 * `db` already has its own healthcheck that `web` depends_on. Readiness against
 * dependencies is a separate endpoint, and it belongs to the package that owns
 * the dependency.
 *
 * No authority-bearing data, no org scoping needed: nothing here is per-tenant.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  const config = loadConfig();

  return Response.json(
    {
      status: 'ok',
      service: 'web',
      // Named from configuration, never hard-coded to a customer (C5).
      app: config.branding.appName,
      environment: config.nodeEnv,
      aiProvider: config.aiProvider,
      // SEC-064 is observable from outside: a demo environment that had somehow
      // been pointed at a live carrier would say so here. Voice is absent because
      // it is cut for this run (ADR-009), not because it was forgotten.
      messaging: {
        sms: config.messaging.smsProvider,
      },
      time: new Date().toISOString(),
    },
    {
      status: 200,
      headers: { 'cache-control': 'no-store' },
    }
  );
}
