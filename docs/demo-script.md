# SeniorSocial synthetic demo — cold start and reset

This guide is self-contained for a local Windows PowerShell review. The base database fixture function is `wp-034.v1`; the complete reset result, including the ss-n0 journey overlay, is `wp-034.v1+ss-n0.v1`. Every person, organization, location, message, and contact is synthetic. Email addresses use the non-deliverable `example.invalid` domain, phone fields are empty, SMS uses the simulator, email stays inside local Mailpit, voice is unavailable, and every demo account has outbound preferences disabled.

Current integration limitation: the Compose worker still runs a placeholder that exits when `packages/worker` exists. Stop workers before using the reset. Reset takes table locks while suppressing immutable-history triggers, so other tenants' database activity can briefly wait; their data is preserved.

## Cold start

From the repository root, with Docker Desktop running:

```powershell
pnpm install --frozen-lockfile
pnpm demo:reset
pnpm demo:up
```

`demo:reset` waits for the database, then runs `pnpm db:migrate`, `pnpm db:seed`, and `pnpm exec tsx packages/db/seed/demo/run.ts` with the local migration-owner connection. The canonical local-demo launcher supplies the same synthetic-only assistance encryption key used by the ss-n0 runtime when the caller does not set one. To exercise a custom local key, set `ASSISTANCE_ENCRYPTION_KEY` before both `pnpm demo:reset` and `pnpm demo:up`; the launcher preserves it unchanged. The key is process-only and is not written to the generated lane environment file or logs. The direct reset runner remains fail closed: invoking `packages/db/seed/demo/run.ts` without a key stops before connecting or changing fixture data. The launcher stops immediately if any reset step fails.

The reset runner prints JSON. It must report `fixtureVersion` as `wp-034.v1+ss-n0.v1`, exact counts, `notification_outbox: 0`, and `elapsedMs` under 120000. `pnpm demo:up` then starts and health-checks the managed, detached ss-n0 host web process. It supplies that runtime with the same synthetic default-or-inherited `ASSISTANCE_ENCRYPTION_KEY` contract as reset; do not launch a second Next process. Open `http://localhost:3100`. Mailpit is local-only at `http://localhost:8125`.

## Demo accounts

Use `POST http://localhost:3100/auth/demo-code` with JSON such as `{"code":"DEMO-SENIOR"}`. Save the returned cookies for later requests. Codes are single-use until reset.

| Role | Synthetic display name | Demo code |
|---|---|---|
| Resident | `[SYNTHETIC] Avery Example` | `DEMO-SENIOR` |
| Caregiver | `[SYNTHETIC] Casey Example` | `DEMO-CAREGIVER` |
| Staff | `[SYNTHETIC] Jordan Example` | `DEMO-STAFF` |
| Partner | `[SYNTHETIC] Morgan Example` | `DEMO-PARTNER` |
| Support | `[SYNTHETIC] Riley Example` | `DEMO-SUPPORT` |
| Admin | `[SYNTHETIC] Taylor Example` | `DEMO-ADMIN` |

Example:

```powershell
Invoke-WebRequest -SessionVariable DemoSession -Method Post -Uri 'http://localhost:3100/auth/demo-code' -ContentType 'application/json' -Body '{"code":"DEMO-SENIOR"}'
```

Walk the seven-day synthetic events list as the resident, then inspect the assistance, ride, moderation, and translation review queues as staff/admin. The admin content area starts with one content page, one FAQ, and one announcement. Any status shown in these records is fixture state, visibly synthetic.

## Between-reviewer reset and convergence

Stop the host web process and any workers before resetting. Run the following in the original maintenance shell using the migration-owner `DATABASE_URL`, never the web runtime connection. Database EXECUTE permission denies runtime callers even if they forge actor context. The cold bootstrap accepts the fixed synthetic admin ID only when that account is absent; subsequent resets require its active demo admin role. Reset runs under one transaction and advisory lock and rolls back on failure. Run it twice; both JSON `counts` objects and `fixtureVersion` values must match exactly:

```powershell
$env:DATABASE_URL = 'postgres://ss:ss_dev_only@localhost:5532/seniorsocial'
$env:DATABASE_SSL = 'disable'
$env:ASSISTANCE_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
$env:AUTH_TOKEN_PEPPER = 'local-development-auth-pepper'
$env:DEMO_RESET_ACTOR_ID = '34000000-0000-4000-8000-000000000006'
pnpm exec tsx packages/db/seed/demo/run.ts
pnpm exec tsx packages/db/seed/demo/run.ts
```

Each successful run leaves one `demo.reset` audit event naming only the fixture version and generic changed-field metadata; it does not log account codes, contacts, content values, or the pepper. A cross-organization id or any non-admin actor is denied as not found.

To remove the local demo stack:

```powershell
pnpm demo:down
```
