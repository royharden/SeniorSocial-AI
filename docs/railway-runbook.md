# Railway staging, production, and migration/cutover preparation

Status: **local preparation only; external execution blocked**. This document and
`infra/railway/` do not authorize Railway authentication, provisioning, uploads,
deployments, purchases, secret changes, DNS changes, or requests to a deployed
service. The integrator/release owner must separately authorize and perform each
external action.

The preparation is one sequence shared by WP-036, WP-040, and WP-042. It replaces
calendar-based staging and cutover prose with evidence gates. Stop at the first
unexplained failure. Do not retry until the failure has a named cause and a new
cutover attempt has been declared.

## 1. Fail-closed identities

These literals are intentionally unresolved in
`infra/railway/release-record.template.json`:

| Variable | Required resolved form | Who supplies it |
|---|---|---|
| `SEALED_CANDIDATE_SHA` | Exact 40-character lowercase Git SHA of a clean, sealed checkout | Integrator after all candidate repairs land |
| `DEPLOYED_BASE_URL` | HTTPS origin only; no credentials, path, query, or fragment | Authorized deployer after Railway exposes the service |
| `IMAGE_DIGEST` | Registry-returned OCI manifest digest, `sha256:` plus 64 lowercase hex characters | Authorized registry/deploy operator after the one permitted image upload |

`node infra/railway/release-gate.mjs` rejects these literal placeholders. Do not
replace a missing fact with a tag, short SHA, local Docker image ID, HTTP URL, or
Railway deployment ID.

## 2. Reconciled source contract

- The repository's implemented web health route is `/api/v1/health`. It returns
  process/configuration liveness and deliberately does not probe PostgreSQL.
- The worker implements `/healthz` on `WORKER_HEALTH_PORT`.
- `infra/docker/Dockerfile` target `release` is the single application artifact.
  `SENIORSOCIAL_PROCESS=web` runs the Next standalone server;
  `SENIORSOCIAL_PROCESS=worker` runs the worker; the pre-deploy command invokes
  `migrate-seed`. All three roles therefore come from one `IMAGE_DIGEST`.
- `pnpm db:migrate` executes the ordered SQL migrations transactionally and uses
  a PostgreSQL advisory lock. Migration `0170_wp-023_rag.sql` requires the
  `vector` extension. `pnpm db:seed` upserts the synthetic two-organization core
  seed. Seed execution additionally requires `SENIORSOCIAL_SEED_ALLOWED=true`.
- Railway's legacy `railway.json`/`railway.toml` Config as Code is deprecated and
  reaches its documented hard cutoff on 2026-12-01. This package therefore does
  not add a legacy config file. `infra/railway/deployment-contract.json` is an
  audit contract for the integrator-owned current Railway IaC/dashboard settings,
  not a file that silently applies cloud state.
- A generic `pgvector/pgvector` image proves vector support but does **not** prove
  Railway PITR support. No database image is selected here. The chosen service
  must prove PostgreSQL 16, available/installed `vector`, and healthy Railway
  PITR together before either environment passes.

## 3. Local candidate and image preparation

Run only after the integrator supplies `SEALED_CANDIDATE_SHA` and while the exact
checkout is clean:

```powershell
$env:SEALED_CANDIDATE_SHA = '<resolved 40-character SHA>'
$env:LEAK_TERMS_FILE = '<private absolute path outside the repository>'
pwsh infra/railway/prepare-image.ps1 `
  -SealedCandidateSha $env:SEALED_CANDIDATE_SHA `
  -LocalImageRepository 'seniorsocial-local'
```

The script checks `HEAD`, rejects a dirty tree, runs the repository's fail-closed
leak scanner over the complete upload surface, and only then builds target
`release`. It performs no upload. `LOCAL_IMAGE_ID` is local build evidence, not
`IMAGE_DIGEST`.

Before any future upload, also require the sealed candidate's local control
record to contain zero failures and zero skips for:

1. `pnpm verify:e2e:journeys` (the 24 EN/ES Standard/Easy journey actions),
2. `pnpm verify:full:a11y`,
3. `pnpm verify:full:evals` (stub provider, zero external spend), and
4. the R-24 smoke list in section 7 against the local release stack.

If any check fails or skips, stop. Never upload first and promise to finish the
control group later.

## 4. External prerequisites — all currently blocked

An authorized release owner must resolve all of these outside this local-prep
package:

1. Approve Railway account/project/environment actions and any required plan or
   private-registry cost. No purchase is implied.
2. Select an OCI repository supported by Railway. Build and push target `release`
   exactly once after the section 3 leak scan, then capture the registry's OCI
   manifest digest as `IMAGE_DIGEST`. Disable tag-based automatic updates.
3. Configure current Railway Infrastructure as Code (`.railway/railway.ts`) or
   equivalent reviewed service settings. That path is integrator-owned and is
   intentionally not edited here.
4. Provision isolated staging and production PostgreSQL 16 services and volumes.
   Prove `vector`, PITR compatibility, private TLS connectivity, and distinct
   environment credentials before application deployment.
5. Supply secret values through Railway's secret store without printing them.
   Required names are listed in `deployment-contract.json`; values never enter a
   command transcript, release record, Git diff, or build context.
6. Authorize any custom-domain/DNS work separately.
7. Adapt or approve a deployed-target Playwright harness. The current canonical
   credentialed journey setup creates a disposable local database and fixes its
   cookie origin to `http://localhost:3130`; claiming it ran unchanged against
   `DEPLOYED_BASE_URL` would be false. Until that separately owned harness change
   lands, deployed e2e/a11y comparison remains blocked and cutover cannot pass.

## 5. Database creation gate (repeat per environment)

At service creation, before seed data or application traffic:

1. Confirm PostgreSQL major 16 and that `vector` appears in
   `pg_available_extensions`.
2. Enable Railway PITR immediately. Wait for healthy WAL archiving and an actual
   restore range; a toggled setting without a restore range is not a pass.
3. Create the first custom-format logical dump outside the repository:

   ```text
   pg_dump "$DATABASE_URL" --format=custom --no-owner --file "<private-backup-path>"
   ```

4. Record the dump's SHA-256 and nonzero size without recording its credentials
   or contents.
5. Restore that exact dump into an isolated scratch database with
   `pg_restore --no-owner --exit-on-error`. Record success, then remove the
   scratch resource only under the authorized operator's cleanup procedure.
6. Run the release image pre-deploy command exactly once:

   ```text
   node infra/railway/process-entrypoint.mjs migrate-seed
   ```

7. Confirm migration `0170_wp-023_rag.sql` installed `vector`, the latest
   migration name is recorded, and only synthetic seed rows exist.

Any failure stops the environment. A database restore creates a separate target;
do not overwrite or hand-edit the failed database while calling the attempt green.

## 6. Staging (WP-036)

1. Connect both application services to exactly
   `OCI_REPOSITORY@IMAGE_DIGEST`, never a mutable tag. Web and worker must report
   the same digest.
2. Configure web with `SENIORSOCIAL_PROCESS=web`, `PORT=3000`, health path
   `/api/v1/health`, and a 300-second timeout.
3. Configure worker with `SENIORSOCIAL_PROCESS=worker`, `PORT=9100`,
   `WORKER_HEALTH_PORT=9100`, health path `/healthz`, and a 300-second timeout.
4. Configure the web service pre-deploy command from the shared image as
   `node infra/railway/process-entrypoint.mjs migrate-seed`, timeout 600 seconds.
   Do not configure it independently on worker, which could race the seed.
5. Require pre-deploy success, then require Railway deployment status
   SUCCESS/Active **after** each configured healthcheck returns 2xx. Container
   start without configured health gating is a failure.
6. Resolve `DEPLOYED_BASE_URL`, verify TLS, and run section 7 plus the authorized
   deployed-target e2e/a11y overlay. Run the zero-spend eval suite locally at the
   sealed SHA and bind its receipt to this deployment.
7. Compare the deployed results with the sealed local release record. Every
   difference is a failure, not an annotation to a pass.
8. Complete a digest rollback rehearsal to a distinct known-good digest, prove
   health, then restore `IMAGE_DIGEST` and prove health again. Stop after one
   unexplained failure.

## 7. Smoke and R-24 overlay

Run each item against `DEPLOYED_BASE_URL`; zero skips are permitted.

1. Health returns 2xx, `status: "ok"`, `service: "web"`, `environment:
   "production"`, and no secret or tenant data.
2. Senior EN Easy Mode loads; EN → ES → EN persists.
3. Directory search and grounded concierge response cite a seeded directory ID;
   AI-off still exposes human handoff.
4. Event RSVP and waitlist promotion behave at capacity.
5. Spanish Easy Mode ride completes through the exact state vocabulary to
   `confirmed_by` while accessibility fields survive.
6. Priority Assistance keeps 911 guidance visible, reaches the staff queue, and
   exposes truthful pending/SLA state.
7. Staff ride dispatch update becomes visible to the senior.
8. Caregiver item-by-item grant/read-back is audited; immediate single-scope
   revocation denies the next request.
9. Forum human report and AI flag both reach the human moderation queue without
   automatic hiding.
10. Admin queues render; CSV service import and scoped JSON/CSV exports succeed
    without small-group/person leakage.
11. Global/per-feature AI kill switches preserve ordinary save and human paths;
    zero-spend configuration is verified unless live AI has separate approval.
12. Security headers (including HSTS only over TLS), simulator-only outbound
    messaging, worker health, and clean bounded log tails are confirmed.

## 8. Production promotion (WP-040)

Production is promotion, not rebuild:

1. Re-run the candidate identity and leak gates before any later upload attempt.
   If the registry already contains the exact scanned `IMAGE_DIGEST`, upload
   nothing.
2. Point production web and worker at the same
   `OCI_REPOSITORY@IMAGE_DIGEST` that passed staging. A new build, tag-only
   reference, or different digest returns the process to staging.
3. Use distinct production secrets and database. Keep `SMS_PROVIDER=simulator`
   and `AI_KILL_SWITCH_GLOBAL=true` until separate live-provider authorization.
4. Repeat section 5 migrate-and-seed against empty production and require both
   configured health gates before traffic.
5. Attach a custom domain or change DNS only under explicit authorization. TLS
   on a Railway-provided origin can establish technical readiness without DNS.
6. Run section 7, deployed e2e/a11y, zero-spend eval receipt binding, and the
   local-release diff. Any failure or skip stops cutover.

## 9. Migration/cutover record (WP-042)

Copy the template to an integrator-owned evidence location, never back into this
template. Fill it only with evidence, set `external_actions_authorized: true`
only when that authorization exists, and validate it:

```text
node infra/railway/release-gate.mjs record <release-record.json>
```

The validator requires resolved candidate/URL/image identities, the leak scan
bound to the candidate and completed before upload, tag-free digest references
for both services, PostgreSQL 16 plus observed pgvector version, a concrete PITR
restore range, nonempty first dump and isolated restore, migrate-before-seed,
and seed-before-deploy. Every gate records a UTC completion time and SHA-256 of
its evidence; paths or words such as `PENDING`, `TODO`, and `TBD` are not
evidence. Production additionally binds the passed staging record SHA-256 and
must exactly match its candidate and image digest. The validator also requires
zero-failure/zero-skip health/smoke/e2e/a11y/eval/R-24/diff gates and a fully
ordered rollback rehearsal to a distinct digest followed by restoration and
health proof of the promoted digest. A `PENDING` template is expected to fail.

## 10. One-failure stop and digest rollback

On the first unexplained deploy, migration, health, smoke, e2e, accessibility,
eval, overlay, or diff failure:

1. Stop promotion and preserve the failing deployment/database evidence.
2. Read the previous passed release record; never choose a digest from memory or
   from a mutable tag. Hash that record and store its SHA-256 with the rollback
   evidence so the known-good source is unambiguous.
3. Reconnect only the failed application service to
   `OCI_REPOSITORY@ROLLBACK_IMAGE_DIGEST`, then require its configured health
   gate. Railway's current CLI surface supports a Docker-image source through
   `railway service source connect --image <repository@digest> --service <name>`;
   the authorized operator must still verify the exact installed CLI syntax.
4. For incompatible database state, use an additive PITR restore to a separate
   service or the rehearsed logical restore. Never run a down migration or reset
   a database containing valuable data as an application rollback shortcut.
5. If the one rollback fails, mark cutover incomplete. Further repair is a new
   attempt, not a retry hidden inside the original record.

A passed record sets `attempt.unexplained_failures` and `attempt.retries` to
zero. It records the rollback start, rollback health pass, candidate restoration,
and candidate health pass in that order. Merely changing a service source and
writing `rehearsed: true` does not pass validation.

## 11. Current external blockers

- `SEALED_CANDIDATE_SHA` is pending the integrator's final repaired candidate.
- `DEPLOYED_BASE_URL` and `IMAGE_DIGEST` cannot exist before separately
  authorized external work.
- A PostgreSQL 16 image/service proven to support both pgvector and Railway PITR
  has not been selected or provisioned.
- OCI repository choice, private-image plan eligibility, secrets, Railway
  project/environments, custom domain, and DNS remain unapproved/unconfigured.
- The exact canonical credentialed e2e/a11y suites are not yet remote-origin
  capable; their current local fixture/origin coupling requires a separately
  owned harness change before migration-diff evidence can be truthful.

Primary platform references checked 2026-09-11: Railway
[healthchecks](https://docs.railway.com/deployments/healthchecks),
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command),
[PITR](https://docs.railway.com/volumes/point-in-time-recovery),
[backup and restore](https://docs.railway.com/guides/postgres-backups-restores),
[Docker image service sources](https://docs.railway.com/services), and
[Config as Code deprecation](https://docs.railway.com/config-as-code).

Prepared and signed: 0331_Codex_GPT56-SOL_Sub_WP036042DeployPrep_Builder
