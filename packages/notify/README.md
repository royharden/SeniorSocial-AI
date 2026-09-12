# Notification backend slice (WP-009)

`createNotify` composes the WP-003 PostgreSQL repository with trusted server
authorization, feature flag, audit, rendering, adapter and queue ports. It exposes
`replace`, `enqueue`, `send`, `disclose`, `recover`, and `flushAudit`. Authenticated
inbox/preferences/print routes and shell settings/print pages consume the real
WP-004 session boundary. All outbound remains synthetic local capture.

## Trust and preference behavior

The HTTP/session boundary must supply `Identity` from authenticated server context,
never request JSON. `Authorization.canNotify` must verify active tenant membership,
recipient and current consent for the requested purpose. `canDisclose` must perform
the appropriate caller/resource check; knowing a callback code grants nothing.
Missing or throwing authorization denies before rendering or creating a job.
Preference editing is self-only. Repository methods are internal trusted server
APIs; do not expose them directly as unauthenticated endpoints.

The immutable WP-002 Preferences shape is retained. `channels` contains purpose
keys (`task_notice`, `urgent_assistance`, `event_reminder`, `message`,
`forums_digest`, `recommendations`), each mapping `email`, `sms`, and `voice` to
explicit booleans. Upstream producers map their domain events to these purposes.
Omitted purpose/channel selections preserve prior choices, including explicit
refusals. A new recipient defaults to `no_outbound: true`; no channel defaults on.
Quiet-hours start/end are distinct `HH:mm` values with an IANA timezone, or the
whole quiet-hours object is empty. Real UTC minute traversal handles DST skips and
folds. Only `urgent_assistance` bypasses quiet hours; no purpose bypasses no-outbound.

Shared-phone SMS/voice use fixed localized minimal text without calling the
sensitive renderer. The separate disclosure API authorizes before invoking its
render callback. Authorizers and renderers must themselves avoid disclosing data
in exceptions/logs. Contact destinations are not saved in audit intents.

## Delivery and recovery

Per-recipient transaction locks serialize preference and outbox changes. A stable
SHA-256 key namespaces the producer key by tenant, recipient and channel. Replayed
keys reuse the original payload and row. `send` checks fresh authorization,
preferences and voice flags before claiming a job; claiming commits `sending` and
an immutable `started` fact before invoking any adapter. Other workers cannot send
that row again. Only explicit adapter confirmation yields `delivered`, always
labelled `synthetic: true`. PostgreSQL requires confirmation evidence in the same
commit and prohibits conflicting result facts or mutable attempt history.

A confirmed rejection becomes `send_failed`, with a one-minute retry delay and the
same delivery key. Exceptions, malformed receipts and uncertain acceptance become
`ambiguous`. A process crash can leave `sending`. Those two states are deliberately
excluded from automatic recovery: a future reconciliation workflow must inspect
provider evidence before any resend. This trades automatic recovery of uncertain
sends for duplicate prevention. Requests such as rides are never mutated here.

`JobQueue.enqueue` is an injected transport boundary. The pg-boss 12.26.3 bridge in
`packages/worker` uses canonical `notify.send.email|sms|voice` names and sets `singletonKey` to
`payload.idempotency_key`; `dueAt` is the scheduling instant. Enqueue attempts can
repeat after outages; the consumer must call the idempotent `send`. The durable
outbox exists before queue submission. Call `recover` for each trusted tenant/user
partition to resubmit pending/failed rows after a bridge outage. The worker runs
this recovery at startup and every minute for its explicitly configured org.
`WORKER_DATABASE_URL` is the queue connection; `DATABASE_URL` must be a constrained
application role, and `SENIORSOCIAL_ORG_ID` selects the trusted partition. The
exclusive queue policy deduplicates waiting/active publications; durable outbox
claims prevent redelivery even after queue completion. The consumer never derives
authority from a pg-boss job ID: it validates tenant/recipient/payload and matches
the entire immutable outbox payload before dispatch.

Audit intents are persisted transactionally and emitted after commit. The sink
materializes database-assigned id/time per the WP-005/WP-006 boundary. Sink failures
are surfaced, and intents remain for `flushAudit`/`recover`. Delivery is at least
once; concurrent flush/retry can emit a duplicate intent. The real WP-006 sink
commits before the pending marker is acknowledged. The pending row ID is carried
in `audit_events.request_id` so retry duplicates can be correlated losslessly.
Approved actions are
`notification.preferences_changed`, `notification.queued`,
`notification.attempted`, and `notification.suppressed` (integrator ruling 688df3e).

## Local adapters and flags

`notify.voice.real_send` is evaluated freshly at enqueue and send. Canonical false
selects the deterministic synthetic voice simulator; true fails closed because
this slice has no real provider. SMS always uses its deterministic simulator.
`createSimulator` supports deterministic confirmed/failed/ambiguous fixtures.

`createLocalAdapter` sends email through Mailpit's documented
[capture API](https://mailpit.axllent.org/docs/usage/sending-messages/).
Only numeric-loopback HTTP endpoints are accepted, redirects are refused, and all
addresses sent to Mailpit use synthetic `.invalid` recipients. The original
destination is not transmitted. Never configure auto-relay or release captured
messages from this local stack. Mailpit is a capture service, not evidence of real
recipient delivery. No network is used for SMS or voice.

## Validation

Dependencies: `@seniorsocial/db`, `@seniorsocial/contracts`, `@seniorsocial/audit`,
and `@seniorsocial/flags` (`workspace:*`),
`postgres` 3.4.9; dev pins follow the workspace. The integrator owns lockfile wiring.
Migration `0040_wp-009_notify.sql` uses the existing flat WP-003 runner; its down
companion removes only this slice. Runtime uses a non-owner role inheriting
`seniorsocial_app`; owner/superuser/BYPASSRLS connections are refused.

Run from the coding root:

```powershell
pnpm --filter @seniorsocial/notify typecheck
pnpm --filter @seniorsocial/notify lint
pnpm --filter @seniorsocial/notify test:unit
$env:DATABASE_URL = 'postgres://ss:synthetic-test-only@127.0.0.1:55439/seniorsocial_wp009_test'
$env:MAILPIT_URL = 'http://127.0.0.1:58039/'
pnpm --filter @seniorsocial/notify test:integration
```

Integration tests require a dedicated database of exactly that name and reset its
synthetic public schema. They never skip silently if the services are absent. The
Mailpit suite sends a synthetic local capture only.

## Inbox and printable source snapshots

`createResidentRepository` exposes the trusted server producer port `publish`,
plus recipient-scoped `list` and `markRead`. In-app
publication is independent of outbound preferences. Migration 0041 enforces both
tenant and recipient RLS. Every runtime operation also verifies an active account.
Producers must supply an authorized identity, never a request-body identity.

`createPrintService` accepts an injected `ScheduleSource`. Its authenticated route
and the exact `notify.render.print` queue share one atomic render/materialization
boundary writing canonical `print_jobs` with `as_of` and `source_version`.
The queue accepts exactly `{idempotency_key, org_id, user_id, week_of}` and the
bridge uses the unchanged payload key as `singletonKey`. Producers should use
`printIdempotencyKey` to namespace queue-global keys by tenant, resident and week;
a deduplicated/colliding publication returns `published: false`, never success.
Before publishing, authenticated producers call `service.request(identity,payload,recheck)`
with the current session authorization callback. This commits an immutable,
recipient-scoped `print_requests` record without reading a schedule. Publication
failure can retry the same request. The consumer requires an exact persisted
org/user/week/key match before reading either a source or a prior result; queue
data alone grants no recipient authority. Synchronous keyed rendering creates
the same evidence through its authenticated callback. The worker also enforces
its configured tenant and active recipient. No authority comes from a pg-boss ID.

Explicit key retries return the original immutable result and reject a changed
week. A synchronous request without a key derives a stable key from its tenant,
recipient, week and current source version. Reusing that version with different
content fails. The API optionally accepts `week_of` and `idempotency_key` to read
the exact queued result through the same boundary; identity always comes from the
WP-004 session. Unauthenticated requests fail before any print job is created.

The public route and worker use an explicit schedule-source registry. The event
adapter contributes only the authenticated resident's current attending RSVPs;
ride and assistance slots remain `not_registered` until their domain owners wire
adapters. A registered adapter failure is labelled `unavailable`, never converted
to an empty plan. Each item carries its source key, version and observation time,
and JSON/HTML expose the status of every expected source. The legacy empty source
remains available to isolated callers with an explicit
`schedule:no-connected-sources:v1` version. Print jobs are outputs and never
masquerade as the current source. Already printed copies cannot be recalled.

Due WP-012 reminder intents reconcile idempotently into the authenticated
resident inbox using one logical `event-reminder:<event-id>` source across HTTP
reads and all outbound channels. This in-app projection is independent of contact
choices and does not claim an outbound send. It requires a currently active
account, published event and attending RSVP in the exact tenant/recipient scope.
Only events that have not started are eligible for new inbox materialization.
Each read materializes at most 100 missing sources, holding RSVP/account row
locks through commit so an in-flight cancellation or account hold wins before
publication. The worker's inbox boundary applies the same current-row checks.
The selected resident UI locale supplies the HTTP copy; a confirmed outbound
worker uses its immutable payload locale, and the first authorized materialization
wins if those paths race.
The non-protected Spanish reminder copy remains an explicitly labelled machine
draft until human review; selecting Spanish does not confer reviewed provenance.

The worker rechecks the active account and current attending RSVP before every
adapter boundary and again before inbox publication. A failed inbox write retries
the state transfer from the already-delivered outbox row without sending outbound
a second time. Durable recovery also finds delivered event rows with no matching
recipient inbox source, so exhausted queue retries cannot strand a confirmed
notice. Worker discovery includes delivered-event recipients; recipient-scoped
reconciliation excludes already-published sources.

Completion integration tests require a separate local database named
`seniorsocial_wp009_completion_test` in `WP009_COMPLETION_DATABASE_URL`. They reset
only that guarded database's synthetic public and wp009boss schemas. The browser
suite consumes that fixture with a constrained `DATABASE_URL`,
`AUTH_TOKEN_PEPPER=synthetic-completion-pepper`, and the fixture org ID. Browser
coverage uses Next dev's localhost origin and validates Easy Mode and axe.

```powershell
# After the dedicated fixture database exists; credentials below are synthetic.
$env:WP009_COMPLETION_DATABASE_URL = 'postgres://postgres:synthetic-test-only@127.0.0.1:55439/seniorsocial_wp009_completion_test'
pnpm exec vitest run tests/integration/WP-009/completion.test.ts
$env:DATABASE_URL = 'postgres://seniorsocial_wp009_completion_login:synthetic-test-only@127.0.0.1:55439/seniorsocial_wp009_completion_test'
$env:AUTH_TOKEN_PEPPER = 'synthetic-completion-pepper'
$env:SENIORSOCIAL_ORG_ID = '11111111-1111-4111-8111-111111111111'
pnpm exec playwright test --config tests/e2e/WP-009/playwright.config.ts
```

Current remaining integration work: ride/assistance schedule registrations from
their domain owners; translated notification settings/print copy in the shared
catalogs; production provider authorization (all real outbound stays disabled).
