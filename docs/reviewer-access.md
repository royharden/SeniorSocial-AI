# Local reviewer access — ss-n0

This packet is for the local synthetic stack only. Recording status is **complete for private-local evidence**; see the [criterion-mapped storyboard](./demo/storyboard.md) and its [known limitations](./demo/known-limitations.md). Do not treat this document as a public URL, deployment notice, delivery notice, accessibility certification, or credential for any non-local system.

**Runnable: true for the documented local synthetic path.** The accepted unspliced native capture is `WP-041-sealed-tour-c379d2b-r3-realtime2.webm`, SHA-256 `1A46195319956BE71F6B6CBE7589D7F7B7361753DE2147AC11429E4A2410BF26`, recorded from sealed application SHA `c379d2b69a162d8fab46409bdb5ed9af1373b3da` and retained under integrated receipt commit `8863b94`. The exact-candidate gate passed **38/38 in 8.4 minutes with zero failures or skips**; the accepted file reports **109.120 seconds of container duration** across **106.164 seconds of wall time**. The historical integrated WP-030/WP-032 closeout remains **38/38 in 4.5 minutes with zero failures or skips**. Prose and screenshots never substitute for the accepted recording and its retained receipts.

## Exact local endpoints

| Purpose | URL or route |
|---|---|
| Web | `http://localhost:3100` |
| Health | `http://localhost:3100/api/v1/health` |
| Demo sign-in | `POST http://localhost:3100/auth/demo-code` |
| Local captured email | `http://localhost:8125` |
| Local database UI (operator only; not part of the tour) | `http://localhost:8180` |

The integrated reviewer pages used by the storyboard are `/home`, `/services`, `/concierge`, `/events`, `/rides`, `/help`, `/caregiver`, and `/admin`. The site root `/` is not listed as a tour page because the integrated source currently identifies it as a scaffold placeholder.

## Synthetic role identifiers

These are synthetic local login credentials already defined in the fixture, not private production secrets. They grant the named role in the seeded demo org. This private preparation does not authorize public publication, bid distribution, or deployment; credential distribution remains a separate decision. Send each code only to `POST /auth/demo-code` on `http://localhost:3100`; never enter it on another host.

| Role | Synthetic display name | Synthetic user ID | Demo code |
|---|---|---|---|
| Resident (`senior`) | `[SYNTHETIC] Avery Example` | `34000000-0000-4000-8000-000000000001` | `DEMO-SENIOR` |
| Caregiver | `[SYNTHETIC] Casey Example` | `34000000-0000-4000-8000-000000000002` | `DEMO-CAREGIVER` |
| Staff | `[SYNTHETIC] Jordan Example` | `34000000-0000-4000-8000-000000000003` | `DEMO-STAFF` |
| Partner | `[SYNTHETIC] Morgan Example` | `34000000-0000-4000-8000-000000000004` | `DEMO-PARTNER` |
| Support | `[SYNTHETIC] Riley Example` | `34000000-0000-4000-8000-000000000005` | `DEMO-SUPPORT` |
| Admin | `[SYNTHETIC] Taylor Example` | `34000000-0000-4000-8000-000000000006` | `DEMO-ADMIN` |

## Expiry and reset behavior

- The database reset remains `wp-034.v1`; its atomic reviewer overlay produces complete fixture `wp-034.v1+ss-n0.v1`. Account-code expiry is `2099-01-01T00:00:00Z`. That distant fixture timestamp does not make a code reusable.
- Each demo code is **single-use**. A successful `pnpm demo:reset` re-arms the six codes and restores the synthetic fixture.
- A successful demo login creates a **12-hour** demo session. Reset removes sessions; logout/revocation or expiry ends them sooner.
- Never reuse a session cookie between reviewers. Reset between review runs and prepare separate role profiles before recording.

## Satisfied exact-candidate capture gate

For the accepted take, the integrator supplied sealed application SHA `c379d2b69a162d8fab46409bdb5ed9af1373b3da`, the checkout matched it, and the approved operator supplied a disposable local PostgreSQL owner URL privately. That value is not present in this packet, the recording, or retained command transcripts. The operator set `WP030_E2E_ALLOWED` and `WP030_E2E_DISPOSABLE_CLUSTER` to true, set `WP030_E2E_RUN_ID` to a fresh 4–16 character lowercase alphanumeric value, and provided `WP030_E2E_OWNER_DATABASE_URL` only through the private channel.

The following commands were run from the sealed checkout in order and remain the repeatable gate:

```text
git status --short
git rev-parse HEAD
corepack pnpm exec playwright test --config tests/e2e/es/credentialed.playwright.config.ts
pnpm demo:down
pnpm demo:reset
pnpm demo:up
curl.exe -fsS http://127.0.0.1:3100/api/v1/health
```

For the accepted take, the first command printed nothing, the second equaled the sealed application SHA, and the credentialed command reported exactly 38 passed, 0 failed, and 0 skipped in 8.4 minutes. Fixture `wp-034.v1+ss-n0.v1` was confirmed, isolated role sessions were prepared, and both staff and admin assistance-queue checks returned HTTP 200 before capture. After the take, `pnpm demo:down` and cleanup receipts confirmed zero owned containers, volumes, networks, generated state, and temporary auth state.

The complete private-local evidence record contains the sealed application SHA, integrated receipt commit, credentialed command and pass/fail/skip counts, credentialed receipt, fixture version, web-health receipt, capture operator, start/end timestamps, wall and container durations, approved media filename, media SHA-256, and teardown receipt. The accepted capture used one native Playwright context and page with no splice, transcode, or re-encode.

Only `WP-041-sealed-tour-c379d2b-r3-realtime2.webm` is accepted. All R1 and R2 attempts are excluded. The action-frame-compressed diagnostic `WP-041-sealed-tour-c379d2b-r3.webm` is excluded because its 50-second media timeline did not preserve the 429-second wall-time relationship. The incomplete native diagnostic `WP-041-sealed-tour-c379d2b-r3-realtime-incomplete1.webm` is excluded because the capture harness stopped at a network-idle timeout. Neither diagnostic is evidence. The admin translation-review widget displayed `Could not load this section`; that nonblocking observation is outside the scored set and is not evidence of translation-review completion.

## Cold start and shutdown

- From the repository root, `pnpm demo:up` starts the reserved `ss-n0` Compose infrastructure and its detached host web process. It succeeds only after `http://127.0.0.1:3100/api/v1/health` reports the expected web health response.
- The host web binds only to `127.0.0.1:3100`. Its recoverable ownership state is stored outside the checkout and ties the resolved checkout, `ss-n0`, supervisor PID, and an unguessable launch token together.
- `pnpm demo:down` validates that identity before stopping the exact host process, then stops only the `ss-n0` Compose project. A stale or reused PID is never killed.
- The cold rehearsal observed health `ok`, loopback address `127.0.0.1`, idempotent repeated startup with the same owned supervisor, and zero matching state files, listeners, or `ss-n0` containers after shutdown.

## Deterministic journey fixtures

- Caregiver link `41000000-0000-4000-8100-000000000001` connects the synthetic resident and caregiver in `pending` state. It has zero pre-granted scopes and zero read-backs. The resident must choose the itemized scopes, read them back, and confirm before authority exists.
- Event `41000000-0000-4000-8200-000000000001` is visibly synthetic, has capacity 1, and resets with one attendee plus one waitlisted support account. The resident starts without an RSVP and can exercise the full-capacity path.
- Both records are recreated inside the same transaction as each successful demo reset. Two consecutive resets converge to the same IDs, counts, states, and timestamps.

## Deterministic AI-off path

- Reset sets the ss-n0 organization overrides `ai.master=false` and `ai.concierge=false`. Effective evaluation remains false under the authoritative global-and-org precedence, without changing global defaults or another organization.
- On `/concierge`, start the local flow and verify that no AI question control appears. The native `/services` search remains available and returns `[SYNTHETIC] Example support service`; `/help` retains emergency guidance and the staff-assistance request form.
- The local browser rehearsal made only local page and conversation-start requests. The ss-n0 AI event count remained zero, so the packet makes no model-call, provider-result, or spending claim.

## Features disabled or simulated in this packet

| Capability | Local reviewer behavior |
|---|---|
| Real SMS | Disabled; simulator/local capture only |
| Real voice reminders | Disabled/simulated; no carrier claim |
| Web push | Disabled |
| AI CLI subscription bridge | Disabled in every environment |
| RAG | Disabled |
| AI event reranking, conversation starters, summaries | Disabled |
| AI concierge | Disabled by ss-n0 org flags; native directory and assistance remain |
| Guardian/legal-representative activation | Disabled pending City verification design |
| Production reset endpoint | Not applicable; this packet is local only |

Additional feature flags can change only through the integrated flag service and must not be inferred from hidden UI. The authoritative limitations are [kept here](./demo/known-limitations.md).

## Evidence sources

- Accounts: `packages/db/seed/demo/data.ts`.
- Account-code expiry/reset: `packages/db/migrations/0180_wp-034_demo.sql`.
- Demo session lifetime: `packages/auth/src/service.ts`.
- Ports and rehearsed host-web lifecycle: `scripts/lane-launch.mjs` and `tests/integration/WP-034/web-start.test.ts`.
- Disabled features: `agentops/interfaces/feature-flags.md` and `docs/specs/10-security.md`.
