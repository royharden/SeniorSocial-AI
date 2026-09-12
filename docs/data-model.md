# Data model

Status: **built schema, hardening in progress, not release-ready**. PostgreSQL migrations are the authority; `packages/db/src/schema.ts` is a typed application view, not a substitute for the SQL constraints and policies.

## Tenant and identity spine

Every organisation is an `orgs` row and carries its default locale/timezone. `users` have a UUID primary key plus an `(org_id, id)` unique constraint for tenant-scoped references and store locale (`en`/`es`) plus display mode (`standard`/`easy`); `user_roles` holds the closed role set. `profiles` stores preferred/contact and accessibility details. Channel, quiet-hour, and shared-device choices live in `notification_preferences`. `service_categories` and `partners` are organisation-scoped directory vocabulary.

Authentication uses `verification_tokens`, `sessions`, `demo_accounts`, `recovery_contacts`, and `auth_rate_limits`. Tokens store hashes rather than reusable plaintext. Session and verification behavior is implemented in `packages/auth`.

Caregiver consent is represented by `caregiver_links`, `consent_grants`, `consent_scopes`, `caregiver_invitations`, and `consent_read_backs`. Scopes are independent rows; revocation and expiry are data, not UI state. `policy_decisions` records the authorization result and basis.

## Accountability and controls

`audit_events` records actor, optional `on_behalf_of`, action, target, organisation, outcome, reason, and request correlation. `ai_events` records feature, optional prompt version/hash, provider/model, usage, latency, cache state, role, outcome, cost, and reservation linkage. `feature_flags` has global and org rows; effective state is global AND org. `flag_changes` records actor, old/new value, reason, and time; the accompanying audit event carries request correlation.

## Product records

- Directory: `services`, `service_languages`, `service_accessibility`, `service_imports`.
- Events: `event_proposals`, `events`, `event_rsvps`, `event_reminder_intents`.
- Rides: `ride_requests`, `ride_accessibility_conditions`, `ride_transitions`.
- Assistance: `assistance_requests`, `assistance_transitions`, `sla_clocks`.
- Community: `forum_topics`, `forum_posts`, `forum_replies`, `blocks`, `reports`, `moderation_items`, `messaging_moderation_decisions`.
- Direct messaging: `messaging_conversations`, `messaging_messages`, `messaging_reports`, `messaging_report_keys`.
- Intake: `intake_submissions` and append-only `intake_mutations`.
- Admin content: `content_pages`, `faqs`, `announcements`, `admin_mutations`.
- Translation: source versions, qualified reviewers and their events, drafts, and translation events; `current_published_translations` exposes only approved, published drafts matching the current source version.
- Delivery: notification preferences/outbox/attempts/inbox/audit-pending plus print requests/jobs.

## AI and retrieval records

`prompt_versions` binds a feature/version to a SHA-256 and path. Cost is reserved before a paid request in `ai_cost_reservations`; attempts and actual use are held in `ai_cost_attempts`. Per-feature and per-org caps, rate-limit observations, and exact-match cache entries are separate tables. `service_embeddings` is keyed by org/service and records source version/fingerprint, dimensions, model, idempotency key, and the fixed system reindex actor.

## Invariants

- Tenant records use organisation-scoped constraints and forced RLS policies; global flag/environment rows have separate scope rules. The runtime database role must not bypass RLS. `withOrg` alone sets tenant context without verifying that role.
- State changes are constrained enums/checks and, for sensitive workflows, security-definer transition functions.
- Cross-tenant absence is returned as not found; callers do not reveal another org’s record.
- AI text never grants authority. Translation publication requires a current source hash/version and qualified human approval. Assistance and intake submissions are native writes.
- Destructive retention behavior is not complete merely because a foreign key has `ON DELETE`; export/retention/privacy operations remain release work.

## Gaps

The schema for built features is integrated and has unit/integration/security tests. WP-020 reporting/export is not integrated at this base. Cross-module, security, and release verification remain open, so this is not a production data dictionary or retention certification.

## Source anchors

`packages/db/migrations/0001_wp-003_core_tables.sql` through `0170_wp-023_rag.sql`; `packages/db/src/schema.ts`; `packages/db/src/tenant.ts`; `packages/auth`; `packages/policy`; `tests/security`; `tests/integration`; `agentops/build/board.csv`.
