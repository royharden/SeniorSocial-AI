# Messaging (WP-016)

Participant-only native messages use WP-004 server sessions, WP-003 tenant
transactions, forced tenant/participant RLS and the existing WP-007 shell. The
integrator's 2026-09-10 ruling assigns block persistence here; WP-005 does not
implement messaging authorization. `POST /blocks` is the shared block boundary.

Create/list/read/send/report/block take one transaction-scoped tenant advisory
lock. All block inserts also take that lock in a database trigger, followed by
both WP-009 recipient locks in sorted UUID order. Notification delivery holds its
recipient lock until adapter invocation; block therefore cannot commit in the
gap after final authorization and before invocation. Delivery authorization is
a fresh lock-free read, avoiding a recipient-to-org lock inversion. Under READ
COMMITTED, a completed block denies the next read/send in both directions;
an operation already holding the lock linearizes before the block. Blocking
retains native data and hides the conversation from both participants, including
direct nonowner message queries. Tenant serialization deliberately favors simple
correctness for community workloads; it can later narrow to ordered pair locks.

Send and report require `Idempotency-Key` matching contract v5
`^[A-Za-z0-9._~-]{1,160}$`. Missing or malformed keys return 422. A repeated send
key with different body conflicts. Authorization precedes replay lookup. The
canonical participant pair is unique. Reports are unique per reporter and
conversation, and every accepted retry key is retained; changed report input or
reuse of a key for another report conflicts. Reports do not hide/delete content.

Message text appears only in `messaging_messages.body` and participant responses.
Native report reason/note stay in `messaging_reports`. Driver failures are replaced
with fixed errors without causes, original SQL or parameters. No AI, audit body,
message preview, sender display name, or body-bearing job payload exists here.

`MessageNotices.enqueue` participates in the message transaction. `wp009Notices`
inserts a synthetic WP-009 outbox row plus audit intent, using current purpose and
channel preferences, no-outbound and quiet hours under WP-009's recipient lock.
The actual sender is `actor_id` and the audit actor. Payload `resource_id` is the
conversation UUID, allowing fresh authorization; `params` is empty. WP-009 owns
durable recovery, preference rechecks, synthetic delivery and audit materialization.
No adapter is invoked by the messaging API.

## Shared integration requirements

- Pass `createMessageNoticeAuthorization(client)` as the third argument of WP-009
  `createRuntime` in the worker bootstrap. This callback checks both active users,
  the exact current conversation and both block directions; missing integration
  fails closed. It intentionally uses a fresh read without a messaging lock to
  avoid inversion with WP-009's recipient lock.
- The integrator owns the additive conversation-report OpenAPI route, shared
  manifests, lockfile and catalogs. Package dependencies: `@seniorsocial/db`,
  `@seniorsocial/notify`; app uses relative source imports consistently with the
  existing feature runtime. No additional external dependency is required.
- `messaging_reports` is the durable human-review intake. WP-015's shared moderation
  queue is not present at this base. Its owner must integrate an explicitly
  authorized report read/decision adapter; participant-only message bodies must
  not become staff-readable merely because a report exists. Current report RLS
  admits only the reporter, and no hidden owner-role override is supplied.
- Messaging text is catalogued under the `messages` namespace. The byte-exact
  English source version is recorded in `es/messages.status.json`; all Spanish
  entries are machine-generated and awaiting qualified human review. Privacy,
  report and block claims are consequential (`critical: true`) and must remain in
  the resolver's held-English fallback state until approved with complete review
  evidence. Other provisional Spanish entries also fall back to English with the
  resolver's pending-review affordance. The integrator must register `messages`
  in the shared catalog policy and default catalog topology when integrating the
  resolver; this bounded increment does not own those shared files.
- The current start form accepts an exact community-member UUID; the future
  people/profile surface should link its selected member into this flow. No
  additional resident-directory disclosure endpoint was added.

## Checks

From the coding root, with a dedicated local `wp016_test` PostgreSQL cluster:

```powershell
$env:MESSAGING_TEST_CLUSTER_URL='postgres://postgres:wp016_test_only@127.0.0.1:55446/wp016_test'
pnpm exec vitest run tests/unit/WP-016 tests/security/WP-016 tests/contract/WP-016 tests/integration/WP-016 --testTimeout 20000
pnpm exec playwright test -c tests/e2e/WP-016/playwright.config.ts
pnpm exec tsc -p packages/messaging/tsconfig.json --noEmit
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
```

The live suites create unique test databases and roles, perform up/down/up and
nonowner probes, and clean up only those generated targets. Browser checks use
localhost (Next dev's allowed hostname), real WP-004 sessions, two browser contexts,
EN/ES, keyboard focus, status messages and axe. No real outbound is performed.

0230_Codex_GPT6-Astra_Sub_MessagingBuilder
