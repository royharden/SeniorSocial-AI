# Server authorization and item-level consent

`createPolicy(store, audit)` exposes `authorize`, `grant` and `revoke`. Supply identities
and roles from authenticated server context, including the authenticated/verified
resident decision actor for a read-back. Never construct these actors from request
JSON, model output, UI role choices, or a caller-selected resident identifier.
WP-004 authentication and WP-017's resident confirmation UI consume this boundary;
this package provides no temporary login or permissive authentication shim.

`authorize` accepts an explicit actor, decisionActor, orgId, resource, action and
optional actingForResidentId. Load resource metadata through an org-scoped server
repository; do not trust a browser's claim of ownership. An allowed result authorizes
that action only. Do not cache it, reuse it for a later request, or send any protected
record before awaiting it. Denials all return `{allowed:false,status:404,error:'not_found'}`.
An invalid unauthenticated actor is denied without fabricating an audit identity.

| Resource/action | Senior | Caregiver | Staff/admin | Partner/support |
|---|---|---|---|---|
| schedule/read | Own | Scoped delegation | In-org operations | Denied |
| ride/book | Own | Scoped delegation | In-org operations | Denied |
| alert/read | Own | Scoped delegation | Denied | Denied |
| assistance/read | Own | Scoped delegation | In-org operations | Denied |
| event/manage | Own | Scoped delegation | In-org operations | Denied |
| profile/read | Own | Scoped delegation | Denied | Denied |

Every other pair is denied. Operator access never overrides the consent requirement
on an acting-for request. This intentionally small surface does not grant access to
messages, moderation, exports, staff alert disclosure, or administrative settings;
their specific policies must be added alongside their feature workflows and tests.
Cross-org requests are denied before consent queries, and their decision records
and audit intents contain only the authenticated entry actor's org/id and generic
policy outcome, never the supplied resource, resident, target org or decision actor.

The canonical scope mapping is exported as `scopeRules`. One grant command changes
one scope. Only a resident's decision may authorize a grant/revoke; that resident
or a staff/admin entry actor may enter it, and the recipient cannot grant themselves
authority. A grant requires a confirmed read-back. Legal-representative delegation
is not supported. `expectedVersion` is the link version displayed during read-back
(zero for a new pair); stale or competing decisions are denied and require another
read-back. Revocations increment the version, preventing old grants from replaying.
Database triggers require a zero initial version and single-step increments backed
by matching immutable history and its applied scope change; direct rewinds/jumps fail.
Granting an already present scope is denied; revoke it before replacing its expiry.

## Persistence and route wiring

`createPostgresConsentRepository(runtimeClient)` accepts an existing `postgres`
client with a non-owner, non-BYPASSRLS application role. Each operation reserves a
connection, begins a fresh READ COMMITTED transaction, binds `app.current_org_id`
transaction-locally, and commits/rolls back and releases it. The pattern matches
`packages/db`'s `withOrg`. `createConsentRepository(OrgTransaction)` is the lower-level
port for callers already adapting `withOrg`; its queries are parameterized and always
filter by org. A transaction adapter must not use a cached/repeatable-read snapshot.

```ts
import { createPolicy, createPostgresConsentRepository } from '@seniorsocial/policy';

const policy = createPolicy(createPostgresConsentRepository(runtimeClient), auditSink);
const decision = await policy.authorize({
  actor: authenticatedActor,
  decisionActor: verifiedResident,
  orgId: authenticatedActor.orgId,
  actingForResidentId: verifiedResident.id,
  resource: scopedRideResource,
  action: 'book',
});
if (!decision.allowed) return Response.json({ error: decision.error }, { status: decision.status });
// Perform the authorized operation in this request; never persist the decision as authority.
```

Migration `0020_wp-005_consent_policy.sql` creates caregiver_links, consent_grants,
consent_scopes and policy_decisions. Composite keys prevent cross-org links/actors;
RLS is forced and missing tenant context denies access. Consent history and policy
decisions are append-only for the runtime role. Scope resource/action pairings are
checked in SQL. Entry and decision actors are separate on each grant/revoke history
row. Existing scopes are changed only by recording revocation; unrelated scopes
remain untouched. An uncached active-scope query also checks expiry and both users'
active account state. An already-running request may have passed its check before
a concurrent revoke; the next request after the revoke commits is denied.

## Audit contract

The injected `AuditSink.emit(AuditIntent)` receives the shared audit schema's fields
excluding database-assigned id/at. Consent successes emit after the storage transaction
commits; all authenticated denials emit generic `caregiver.denied` intents. Allowed
access emits the current vocabulary's `caregiver.acted`. The recipient scope ID is
the grant/revoke target, entry actor is `actor`, and `on_behalf_of` is the resident
for operator entry or null for resident self-entry. No content, contact data or
arbitrary request text enters these intents.
WP-006 owns audit persistence. Audit failures propagate instead of reporting success;
a consent transaction may already have committed. There is deliberately no policy
audit outbox. WP-006/integration owns durable retry or reconciliation of that gap.

## Verification

Package scripts run typecheck, lint, focused unit/security/contract tests and real
PostgreSQL integration tests. Contract tests require Python with `jsonschema` and
validate the unmodified Draft 2020-12 schema with format checking. Integration tests
require `DATABASE_URL` whose database is exactly `seniorsocial_wp005_test`; they reset
its public schema, never another database. They exercise up/down/up, a non-owner
login, composite FKs, RLS and missing-policy default denial, scoped revocation and
concurrent version conflicts. Use a disposable test database only.
