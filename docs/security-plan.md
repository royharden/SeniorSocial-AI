# Security plan

Status: **controls built in layers; WP-033 hardening and release assurance remain open**. This is an implementation-facing plan, not a compliance certification or penetration-test report.

## Trust boundaries and controls

1. **Identity and session.** Passwordless verification, hashed tokens, expiry, device binding, auth rate limits, and server-derived role/org context live in `packages/auth` and migrations 0010/0011.
2. **Tenant isolation.** Domain repositories use `withOrg` or domain-specific tenant transactions; operational tables carry `org_id`; forced PostgreSQL RLS is the backstop. `withOrg` binds a caller-supplied ID and requires a non-bypass database role; it does not check role constraints itself. Auth, intake, and translation runtimes explicitly reject unconstrained roles. Security tests exercise cross-org negatives; audit remaining compositions before release.
3. **Consent and least privilege.** Caregiver access is scoped, expiring, revocable, and re-authorized per action. Staff/admin operations have explicit role checks. UI hiding and flags do not grant authority.
4. **Sensitive content.** Intake narratives and selected audit bodies use application encryption boundaries. Shared-device notification rules suppress sensitive body content and honor no-outbound/quiet-hours before job creation.
5. **Auditability.** Sensitive actions, denials, flag changes, moderation decisions, and every AI gateway outcome produce tenant-scoped audit/event records with request correlation.
6. **AI isolation.** The gateway has closed features, exact prompt versions, rate/cost caps, provider allowlisting, post-result kill re-checks, and non-AI fallbacks. Serialized outbound canary checks live in the Anthropic package adapter; current app compositions register only the stub and disable caching. Paid-provider transport/guard composition is unfinished. Models have no direct database or tool execution authority and human decisions remain authoritative.
7. **Supply chain and delivery.** Exact tool versions, frozen lockfile, denied dependency install scripts, pinned CI actions/images, leak scanning, secret scanning, lint/type/test/security stages, non-root containers, and environment-specific HSTS are represented in root configuration and tests.

## Required verification before release

- Complete WP-033 across RBAC, rate limits, headers, injection, egress, and destructive-action negatives.
- Complete cross-module journeys and accessibility/Spanish hardening.
- Validate staging with separate secrets and paid-provider spend caps; automated tests must remain on `stub`.
- Exercise AI master and per-feature kill switches and verify every native path still completes.
- Prove backup/restore, retention/deletion, reporting/export scoping, and operational monitoring for the target environment.
- Run an independent security review/penetration test before representing production assurance.

## Incident and rollback posture

Disable a single AI feature or `ai.master` without disabling the platform. Disable real notification adapters independently. Preserve audit and AI-event evidence, rotate affected credentials, isolate the tenant/environment, and roll back application deployment only after checking migration compatibility. Database down migrations exist, but using them is a planned operator action, not an automatic rollback promise.

## Known residual and release gaps

- WP-033 is building; no independent penetration test is recorded.
- Field-level encryption does not protect against a fully compromised application process.
- SMS/voice real sending is disabled; simulation is not carrier-security proof.
- RAG is disabled by default and its retrieval/security surface is not a release claim.
- Staging and production deployment WPs are blocked at this base.
- Privacy retention, production key custody, backup restoration, and formal compliance evidence require environment/operator work.

## Source anchors

`packages/auth`; `packages/policy`; `packages/db/src/tenant.ts`; `packages/db/migrations`; `packages/audit`; `packages/flags`; `packages/ai/src/gateway.ts`; `packages/ai/src/providers.ts`; `pnpm-workspace.yaml`; `.github`; `tests/security`; `docs/specs/threat-model.md`; `agentops/build/board.csv`.
