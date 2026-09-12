# SeniorSocial architecture

Status: **built, with hardening and release gaps**. This describes commit `36edbcc` and distinguishes code that is integrated from contracts that are only declared. “Built” means working code is present; it does not mean release-ready.

## System shape

SeniorSocial is a pnpm monorepo. `apps/web` is the Next.js user and HTTP edge. Domain logic lives in packages and PostgreSQL is the durable authority. The root worker runs notification and print work. Local orchestration is provided by `scripts/lane-launch.mjs`; the root `package.json` defines build and verification stages.

```text
browser
  -> apps/web (pages, route handlers, session context)
      -> policy/auth/flags (authority and runtime controls)
      -> domain packages (business rules)
      -> db.withOrg(...) -> PostgreSQL + row-level security
      -> ai gateway -> stub (current app composition)
      -> notify outbox -> worker -> simulated adapters / print
```

The package boundaries visible in `pnpm-workspace.yaml` are:

- foundation: `contracts`, `config`, `db`, `auth`, `policy`, `audit`, `flags`;
- product: `services`, `events`, `rides`, `assistance`, `forums`, `messaging`, `caregiver`, `intake`, `i18n`;
- AI and retrieval: `ai`, `rag`;
- delivery and presentation: `notify`, `worker`, `tokens`, `ui`, and `apps/web`;
- administration: `admin`.

## Request and authority boundaries

Authenticated route handlers obtain identity from the server-side session; public directory reads use the configured organisation. Domain repositories use `packages/db/src/tenant.ts` and `withOrg`, or domain-specific transactions that set `app.current_org_id`. The binding helper accepts an org ID from its caller; it does not authenticate that caller or itself reject an owner/superuser connection. Auth, intake, and translation runtimes add constrained-role checks. PostgreSQL migrations force row-level security on tenant data as a second boundary, requiring a non-bypass application role. Roles are the closed set `senior`, `caregiver`, `staff`, `admin`, `partner`, and `support` from migration `0001_wp-003_core_tables.sql`.

Caregiver authority is item-by-item and revocable. `caregiver_links`, `consent_grants`, and `consent_scopes` are the durable records; a caregiver is not equivalent to the resident. Operational actions re-check role, organisation, and consent in application/database functions. Feature flags alter availability, never authorization.

AI is behind `packages/ai/src/gateway.ts`. The gateway checks master and feature flags, rate limits, prompt registration, provider routing, cost reservation, and event logging. The Anthropic package adapter checks serialized outbound canaries, but the concierge, forum moderation, and translation app runtimes register only the stub provider. Selecting Anthropic does not enable paid AI in those runtimes. Models propose or classify; application code and humans retain authority. Directory search, native intake/assistance forms, forum reports and human moderation APIs, and manual translation drafts do not depend on AI. This is code-path evidence, not proof of every deployed journey; staff queue decision controls are not yet wired into the dashboard.

## Data and asynchronous work

PostgreSQL migrations are append-only numbered files in `packages/db/migrations`. Operational records carry `org_id`; security-definer functions validate the current tenant and narrow writes. Notifications use an outbox and attempt records. Print requests become print jobs. AI calls write `ai_events` and have durable cost/rate/cache repository support. Current app AI compositions disable caching and use an in-memory cache implementation; concierge conversations are also in memory and are not durable across restarts.

## Contract surfaces

`agentops/interfaces/openapi.yaml` is the declared HTTP contract. `packages/contracts/gateway-interface.ts` is the closed AI contract. JSON schemas under `packages/contracts/src` define shared documents. Route files and contract tests are the evidence that a declared operation is integrated; declaration alone is not implementation.

## Current gaps

- **Hardening:** WP-001, WP-015, WP-022, and WP-031 remain in hardening on the build board.
- **Building:** cross-module journeys (WP-030), Spanish completion (WP-032), and the security pass (WP-033) are not complete.
- **Not yet built:** reporting/export WP-020 and demo-data/reset WP-034 are assigned but not integrated at this base. Some OpenAPI operations therefore have no matching route file yet.
- **Release:** staging and production cutover (WP-036/WP-040/WP-042) are blocked; no deployment or production assurance is claimed.

## Source anchors

`package.json`; `pnpm-workspace.yaml`; `apps/web/app/api/v1`; `packages/db/src/tenant.ts`; `packages/db/migrations`; `packages/contracts/gateway-interface.ts`; `packages/ai/src/gateway.ts`; `packages/worker/src/main.ts`; `agentops/interfaces/openapi.yaml`; `agentops/build/board.csv`.
