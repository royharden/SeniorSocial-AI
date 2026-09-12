# HTTP API

Status: **contracted broadly, implemented incrementally**. The canonical declaration is `agentops/interfaces/openapi.yaml`. The base path is `/api/v1` for product operations. Do not infer that a declared operation is live unless a matching `apps/web/app/api/v1/**/route.ts` adapter and tests exist.

## Conventions

- JSON is the default representation; CSV is accepted for the service import contract.
- Authentication is session based. Route code derives user and organisation context server-side.
- Tenant isolation returns 404 for an inaccessible foreign-organisation resource where existence is sensitive.
- Mutations validate role and, where relevant, caregiver consent. Flags never replace those checks.
- Errors use the shared problem response shape from the contracts package.
- Operational create/transition endpoints use idempotency or state-machine safeguards where their domain contract requires them.

## Declared operation groups

| Group | Declared operations |
|---|---|
| Health/auth | health and readiness; magic link, SMS code, verify, demo code, logout |
| Current user | profile, preferences, caregiver list, printable schedule |
| Directory | services, service detail, categories; admin create/patch/import |
| Concierge | create/read conversation, message, human handoff |
| Events | list/detail, RSVP cancellation, waitlist, proposals, recommendations |
| Rides | resident list/create/detail/transition and staff queue |
| Assistance | resident list/create/detail/transition and staff queue |
| Community | topics, posts, replies, report, block, human moderation queue/decision |
| Messaging | conversations, messages, report |
| Caregiver | invitation/acceptance, links, scope update, revocation |
| Intake | legal and health submission, read/update submission |
| Notifications | inbox and mark-read |
| Administration | users, content, FAQs, announcements, partners, analytics, translations, flags, AI/audit events |
| Reporting/export | tenant-admin aggregate reporting plus aggregate and individual export creation, status, and download |

For exact methods, parameters, bodies, responses, and schemas, use the OpenAPI file rather than duplicating those machine-readable details here.

## Implementation status

The following route families have live adapters and targeted tests: auth; preferences; services; concierge; events; rides; assistance; forums/moderation; messaging; caregiver; intake; notifications/print; translations; flags; reporting/export; and selected admin surfaces. The application tree is the source of truth for adapter presence.

The reporting adapters implement `/admin/reports/{reportName}`, `/admin/exports`, `/admin/exports/{exportId}`, and `/admin/exports/{exportId}/download`. The shared export routes compose tenant-admin aggregate exports with authorized individual account exports. Aggregate reporting currently supports the `channel-activity` report; it requires the database-backed reporting runtime and trusted session context. Export readiness, expiry, format negotiation, concealment, and download integrity remain enforced by the reporting and individual-export services rather than implied by adapter presence alone.

Known contract-to-code gaps at commit `a6a6240`:

- `/me` and `/me/profile` are declared but have no matching route adapter at this base.
- Auth adapters are actually at `/auth/*`, outside `/api/v1`; the declared prefix is not a working alias. `/healthz` and `/readyz` do not have Next route adapters; the web health adapter is `/api/v1/health`. These path differences require reconciliation before claiming OpenAPI conformance.
- An OpenAPI declaration, UI mock, or fixture is not proof of integrated behavior.

## AI boundary

There is no public “call a model” API. Integrated AI product routes call the internal gateway through stub-only runtime compositions at this base. The closed gateway contract requires org/user/role/locale/request context and records an AI event. A killed/refused result returns a human route; this fallback hint does not prove that a matching browser page exists. The model cannot directly write a ride, assistance request, message, alert, moderation decision, or published translation.

## Source anchors

`agentops/interfaces/openapi.yaml`; `packages/contracts/src`; `packages/contracts/gateway-interface.ts`; `packages/reporting/src`; `packages/individual-exports/src`; `apps/web/app/api/v1`; `tests/contract`; `tests/security`; `agentops/build/board.csv`.
