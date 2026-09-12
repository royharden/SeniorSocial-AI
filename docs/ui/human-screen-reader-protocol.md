# WP-031 human screen-reader protocol

Status: **bound template only — not run**. This is not certification, a VPAT, a user study, or a claim that a screen-reader user validated SeniorSocial. The older automated results in [accessibility.md](accessibility.md) and [accessibility-audit.md](accessibility-audit.md) are separate browser evidence and do not establish results for this sealed post-repair candidate.

The executable matrix is [`tests/a11y/WP-031/human-screen-reader-matrix.json`](../../tests/a11y/WP-031/human-screen-reader-matrix.json). It inventories the same 12 routes as the integrated Playwright `route-matrix.ts`, names every integrated status-changing action, and supplies stable journey, step, route, and action IDs for evidence.

## Gate before a person starts

The integrator bound this unrun template to sealed candidate `c379d2b69a162d8fab46409bdb5ed9af1373b3da` at local origin `http://127.0.0.1:3100`, with `candidateState: "post_repair_sealed"`, `boundBy: "0184_Codex_GPT56-SOL_Integrator"`, and `boundAtUtc: "2026-09-12T03:43:26Z"`. Before a person starts, verify those exact values remain in the matrix and run:

```powershell
pnpm exec vitest run tests/contract/WP-031/structure.test.ts
pnpm exec vitest run tests/contract/WP-031/binding.test.ts
```

The first command validates the bound but still unrun template. The second requires this exact binding to validate green and retains negative checks that reject placeholders, malformed SHAs, exact recorded automated-baseline commits, non-loopback URLs, and a candidate not attested as post-repair sealed. The validator proves identity and distinctness only; it cannot prove Git ancestry or chronology from SHA text. The binding attestation records the integrator's separate verification that the selected commit is the intended post-repair descendant and that this matrix matches that commit's routes, accessible names, states, and announcements; it is not human assistive-technology evidence.

Confirm the designated synthetic accounts and records exist before testing. Do not create or capture real resident, caregiver, assistance, ride, or health data. Record fixture identifiers without credentials. If a required record is missing, record `blocker`; do not improvise another person's data.

## Result rules

- `not_run`: no human observation was made.
- `pass`: every expectation in the step was independently heard or reached.
- `fail`: the step was completed but an expectation was not met.
- `blocker`: the step could not be completed or interpreted. Missing data, a crash, an unavailable server, AT/browser failure, and **any sighted assistance** are blockers.

Never turn `blocker` into `pass` after a sighted person identifies a control. Restart from a clean bound run after the blocker is repaired.

## Record the environment

Make one copy of [human-screen-reader-evidence-template.md](human-screen-reader-evidence-template.md) for each of the eight matrix runs. Before opening the app, fill in tester, UTC start time, full bound SHA, exact local URL, locale, mode, OS version/build, browser version, and AT version. Use headphones or a private room if the transcript may include synthetic assistance details.

The required combinations are NVDA + Chrome on Windows and VoiceOver + Safari on macOS, each in English and Spanish, each in Standard and Easy Mode. The retained §9.2 planning text says VoiceOver + Safari on iOS; this assigned execution protocol deliberately uses **macOS**, not iOS. That is an explicit scoped reconciliation, not a claim that the historical sentence changed or that iOS was tested.

## Platform setup and exact navigation

### NVDA + Chrome on Windows

1. Start Chrome without content-changing extensions. Start NVDA. Record versions.
2. Press `NVDA+Space` until NVDA announces Browse mode. `NVDA` means the configured Insert or Caps Lock key.
3. Press `Ctrl+L`, enter the bound URL plus the exact matrix route, and press `Enter`.
4. Press `Ctrl+Home`, then `Tab`. The first focus must be `Skip to main content` or `Saltar al contenido principal`, role link. Press `Enter`; focus must move to the sole `main` landmark.
5. Use `H` for headings and `D` for landmarks. Use `NVDA+F7` when the protocol calls for the Elements List. Use `Tab`/`Shift+Tab` for focus order; use `Enter` for links and buttons, or `Space` when NVDA announces that convention.
6. For an edit/select control, use `NVDA+Space` only when NVDA requires Forms mode. Return to Browse mode before heading/landmark commands.

### VoiceOver + Safari on macOS

1. In Safari Settings > Advanced enable **Press Tab to highlight each item on a webpage**. Start VoiceOver with `Command+F5`. Record versions.
2. `VO` below means `Control+Option`. Press `VO+U`; verify the rotor opens; press `Escape`.
3. Press `Command+L`, enter the bound URL plus the exact matrix route, and press `Return`.
4. Press `VO+Home` (on keyboards where Home is `Fn+Left Arrow`, press `VO+Fn+Left Arrow`), then `Tab`. The first focus must be `Skip to main content` or `Saltar al contenido principal`, role link. Press `VO+Space`; focus must move to the sole `main` landmark. Do not substitute `VO+Shift+Home`, which moves only to the top of the visible area.
5. Use `VO+Command+H` for the next heading. For headings, landmarks, or links, press `VO+U`, use Left/Right to choose the rotor category, Up/Down to choose an item, and `Return` to move there.
6. Use `Tab`/`Shift+Tab` for controls, `VO+Space` to activate, `VO+A` for continuous reading, and `Control` to stop speech.

## Execute each run

For each `coverageRuns[]` item:

1. Set the locale and mode using the named header buttons, then directly reopen `/settings` and verify the corresponding buttons expose `aria-pressed=true`. Verify `html` pronunciation matches the locale. An ES run may encounter strings intentionally held in English; pass only when the English string is also associated with its exact review/unavailability notice. The committed matrix records the current fallback names. If translation review changes those names in the sealed candidate, update and structurally revalidate the matrix before binding it.
2. Execute `JOURNEY-ALL-ROUTES`. On every `routes[]` entry, record the first announcement, skip link, h1 sequence, landmarks, every focusable action, accessible name, role, pressed/checked/disabled/busy state, and exact keystrokes. A screenshot is useful for a missing/obscured focus ring but never replaces what the AT said.
3. Execute `JOURNEY-HOME-SERVICE-SEARCH`. Enter only the seeded query supplied for the run. The result state must announce once after activation, not once per keystroke. Read one listing fully and record its heading, eligibility words/meaning, phone-link name if present, and source-updated date.
4. Execute `JOURNEY-RIDE-ERROR-READBACK`. First leave Pickup date and time empty and submit. Record where focus goes and the entire error announcement. Then use the supplied synthetic ride values. §9.2 requires step position (for example, “step 3 of 6”) and a continuous non-interleaved read-back. The current route matrix names a single `/rides` route; if the candidate exposes no step progression or read-back, record `fail`. Do not invent a route or simulate a step.
5. Execute `JOURNEY-MODE-LANGUAGE`. Record the accessible names, button roles, pressed states, `lang`/voice change, page-change announcement, and the two Easy help-bar link names.
6. Execute every `JOURNEY-STATUS-ACTIONS.actionIds` entry. Use the action's exact seeded precondition. Record every intermediate and final live announcement verbatim, including repeated submissions. A visually changed result that is not spoken is a failure.
7. Save one step row even when the result is `blocker`. Stop only the affected action if continuing could mutate the wrong synthetic record; document the blocker and proceed only with independent read-only steps.
8. Set the run result: `pass` only if every required step passed; `blocker` if any step blocked; otherwise `fail`. `not_run` is permitted only before the run begins.

## Defects and evidence

Every fail/blocker gets a stable defect ID such as `WP031-HUMAN-001`. Record severity, the exact success criterion, journey/step/action/route IDs, exact keystrokes, expected behavior, verbatim transcript, timestamp, and evidence file names. Use:

- `critical`: prevents emergency/human-help access or causes an unsafe/destructive action.
- `high`: blocks a journey, hides a required status/error, traps focus, or requires sighted assistance.
- `medium`: materially confusing name/order/announcement with a usable independent workaround.
- `low`: limited friction that does not obscure meaning or completion.

Record a screenshot for focus/visible-state defects when useful. Record audio/video only with tester consent and only against synthetic data. Never store credentials or real personal data. A recording supplements, but does not replace, the verbatim transcript.

## Completion boundary

Eight filled evidence records are required: two platforms × two languages × two modes. Completion requires zero `not_run` and zero `blocker` results, every failure linked to a defect disposition, and a rerun on the same or a newly sealed candidate after repairs. This protocol alone does not close WP-031 and cannot be described as certification, a VPAT, conformance, or a user study.
