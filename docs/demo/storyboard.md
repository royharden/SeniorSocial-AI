# WP-041 demo storyboard — complete private-local evidence

**Status: COMPLETE — private-local evidence. Runnable: true.** The accepted unspliced native capture is `WP-041-sealed-tour-c379d2b-r3-realtime2.webm`, SHA-256 `1A46195319956BE71F6B6CBE7589D7F7B7361753DE2147AC11429E4A2410BF26`, recorded from sealed application SHA `c379d2b69a162d8fab46409bdb5ed9af1373b3da`. It is retained as private-local evidence under integrated receipt commit `8863b94`; it is not a public URL, deployment, delivery notice, or accessibility certification.

The exact-candidate credentialed gate passed **38/38 in 8.4 minutes, with zero failures or skips**. The earlier integrated WP-030/WP-032 closeout also remains traceable as **38/38 passed in 4.5 minutes, with zero failures or skips**. The accepted file reports **109.120 seconds of container duration** across **106.164 seconds of wall time**. Prose and screenshots never substitute for the accepted recording and its retained receipts.

The planned tour is 11:00 (660 seconds), below the strict 11:59 ceiling in [`packet-manifest.json`](./packet-manifest.json). Stop instead of improvising if a step fails. Never splice a failed attempt into evidence for another revision.

## Recorded gate receipts

The ss-n0 readiness-blocker list in `packet-manifest.json` is empty. The accepted take was produced only after the sealed SHA matched, the exact-candidate credentialed gate passed, reset and startup receipts were retained, both staff and admin assistance-queue checks returned HTTP 200, and final teardown proved zero owned containers, volumes, networks, generated state, and temporary auth state.

The satisfied preparation sequence, retained here for repeatability, was:

1. The integrator supplied sealed application SHA `c379d2b69a162d8fab46409bdb5ed9af1373b3da`. In that exact checkout, `git status --short` was empty and `git rev-parse HEAD` matched the supplied SHA.
2. Through the approved private operator channel, the disposable local owner URL and the three non-secret controls named in `packet-manifest.json` were supplied. `corepack pnpm exec playwright test --config tests/e2e/es/credentialed.playwright.config.ts` reported exactly **38 passed, 0 failed, 0 skipped** in **8.4 minutes**. A green run does not authorize evidence for a different revision; `pass`, `fail`, `skipped`, `not-run`, and `unreleased` are not interchangeable (SC-07).
3. Run `pnpm demo:down` before `pnpm demo:reset`; reset recreates the reserved demo database volume. Then run `pnpm demo:up`, which starts Compose plus the detached host web and returns only after `GET http://127.0.0.1:3100/api/v1/health` succeeds. Retain `curl.exe -fsS http://127.0.0.1:3100/api/v1/health`, and confirm `ss-n0` plus fixture `wp-034.v1+ss-n0.v1`. Reset restores the pending caregiver confirmation, full-event state, and org-scoped `ai.master=false` plus `ai.concierge=false`; do not hand-edit them or use a builder lane.
4. Prepare separate browser profiles for resident, caregiver, staff, and admin. Establish each session through `POST http://localhost:3100/auth/demo-code` using the matching synthetic code in [`../reviewer-access.md`](../reviewer-access.md). Do not show request bodies or cookies on camera. Stop if any required role or route fails.
5. Open [`known-limitations.md`](./known-limitations.md) in a final tab. Close terminals, developer tools, environment views, and logs before capture. Start a new attempt if a required action, narration boundary, or criterion cannot be shown truthfully; never splice across revisions or failed attempts. The accepted capture used one native Playwright context and page with no splice, transcode, or re-encode.

## Timed shot list

| Time | Named WP-030 journey / action | Exact ss-n0 page | Scored criteria | Truthful narration cue |
|---|---|---|---|---|
| 00:00–00:30 | Opening | `http://localhost:3100/home` | A-8, SC-07 | Say “local synthetic demo”; show the candidate SHA and green-gate receipt, never a deployment claim. |
| 00:30–01:15 | Sign-in boundary | session already prepared via `POST http://localhost:3100/auth/demo-code` | F-1, F-2 | Name the synthetic resident role and the single-use/expiry behavior; do not expose a cookie. |
| 01:15–02:45 | **Grounded service help completes** | `http://localhost:3100/services`, then `/concierge` | F-8, F-13 | Search the seeded directory; start concierge; confirm “Talk to a person”; show the created pending request. Never describe it as staffed or dispatched. |
| 02:45–04:00 | **RSVP and capacity waitlist complete** | `http://localhost:3100/events` | supporting journey | Exercise the waitlist path on synthetic event `41000000-0000-4000-8200-000000000001`, which resets to capacity 1 with one attendee and one existing waitlisted account. The resident begins without an RSVP. |
| 04:00–05:30 | **Resident ride request reaches authoritative staff state** | `http://localhost:3100/rides`, then queue display on `/admin` | F-7 | Submit the rehearsed structured accessibility choice. The dashboard displays queue state but has no ride transition control; staff transitions require a separately rehearsed authenticated API action. Show request versus staff state; never call a request a booking. |
| 05:30–06:45 | **Resident priority request enters staff handling** | `http://localhost:3100/help`, then queue display on `/admin` | F-13 | Show 911 guidance and `pending, not yet assigned`. The dashboard has no assistance ownership control; a separately rehearsed authenticated API action must precede showing changed staff state. Make no response-time promise. |
| 06:45–08:30 | **Itemized consent revokes immediately** | `http://localhost:3100/caregiver` | F-11 | Use pending synthetic link `41000000-0000-4000-8100-000000000001`. It resets with zero scopes and zero read-backs: the resident must select scopes, read them back, and confirm before saving. Then revoke and show the next authenticated caregiver API action denied. Guardian/legal-representative activation is not part of this flow. |
| 08:30–09:45 | **AI-off native completion remains usable** | `http://localhost:3100/concierge`, then `/services` and `/help` | F-8, F-13, SC-07 | With the reset-proven AI-off state, show that the AI question box is absent while the seeded directory search and native assistance form remain. The local rehearsal produced zero AI events and no model/provider result; do not imply a live model call. |
| 09:45–10:30 | Mode/language evidence | repeat the gate-selected resident page in Easy Mode and Spanish | A-8, SC-07 | Show the same underlying action in the two tested variants. Describe this as synthetic engineering evidence, not an accessibility audit, VPAT, or user study. |
| 10:30–11:00 | Limitations | local file [`known-limitations.md`](./known-limitations.md) | A-8, SC-07 | Read the recording gate and the material limitations; end without a release, public, or deployment claim. |

The remaining 59 seconds are deliberately unused. The criterion set is the union of WP-041 (`F-1`, `A-8`, `SC-07`) and the WP-030 board row (`F-2`, `F-7`, `F-8`, `F-11`, `F-13`); `packet-manifest.json` maps every member to at least one timed segment. The events segment is retained because it is one of the six named WP-030 journeys, but it is not assigned an invented scored ID.

## Capture disposition

The accepted private-local evidence record contains every field named by `captureGate.evidenceFields` in `packet-manifest.json`: the sealed candidate and integrated receipt; credentialed command, counts, and receipt; fixture and web-health evidence; capture operator and timestamps; wall and container durations; accepted media filename and SHA-256 checksum; and teardown receipt. The exact facts are recorded in `captureEvidence` and the integrated receipt at `docs/evidence/WP-041-sealed-recording-c379d2b.md`.

Only `WP-041-sealed-tour-c379d2b-r3-realtime2.webm` is accepted. All R1 and R2 attempts are excluded. The action-frame-compressed diagnostic `WP-041-sealed-tour-c379d2b-r3.webm` is excluded because its 50-second media timeline did not preserve the 429-second wall-time relationship. The incomplete native diagnostic `WP-041-sealed-tour-c379d2b-r3-realtime-incomplete1.webm` is excluded because the capture harness stopped at a network-idle timeout. Neither diagnostic is evidence, and none may be combined with the accepted take.

The accepted take is complete only within this private-local packet. It does not authorize publication, deployment, credential distribution, production access, delivery to the City, or an accessibility-certification claim. The admin translation-review widget displayed `Could not load this section`; that nonblocking observation is outside the scored set and is not evidence of translation-review completion.

## Traceable sources

- Assignment/status: `agentops/build/board.csv`, rows WP-020, WP-030, WP-032, and WP-041.
- Named journeys and executable assertions: `tests/e2e/journeys/cross-module.spec.ts`.
- Reviewer gate condition: `agentops/readiness/readiness.py` (`WP-030 demo journeys == 100%`).
- ss-n0 ports: `scripts/lane-launch.mjs`; routes: the source paths enumerated in `packet-manifest.json`.
- Synthetic accounts: `packages/db/seed/demo/data.ts`; expiry/reset: `packages/db/migrations/0180_wp-034_demo.sql`; session lifetime: `packages/auth/src/service.ts`.
- Cold-start/reset background only (not copied credentials): `docs/demo-script.md`.
