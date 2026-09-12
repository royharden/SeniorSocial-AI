# Automated accessibility closeout — WP-031

Closeout baseline: `c264e98` (`integration/efficient-build-v1` at the final run)

Run date: 2026-09-11

Runner: Playwright 1.63.0, Chromium, and `@axe-core/playwright` 4.11.1

## Result

The combined WP-031 automated accessibility suite passed: **85/85 tests in 8.6 minutes**. The run used a fresh Next development server, one Playwright worker, and the exact loopback origin `http://localhost:3132`. Port 3132 was selected because another registered run participant owned port 3131; the runner validates and uses the configured origin rather than assuming a fixed port.

Run from the coding root:

```powershell
$env:WP031_BASE_URL='http://localhost:3132'
pnpm exec playwright test --config tests/a11y/WP-031/playwright.config.ts
```

The matrix covers these 12 routes: `/`, `/home`, `/settings`, `/settings/notifications`, `/help`, `/events`, `/caregiver`, `/rides`, `/preferences/confirm?mode=easy`, `/print`, `/services`, and `/concierge`.

Coverage includes:

- English and Spanish in Standard and Easy modes.
- Desktop (1280×800) and narrow (360×640) layout checks.
- Axe scans after the route's user-observable `main#main h1` has settled.
- Complete native keyboard traversal, visible focus, first-Tab skip link behavior, and a unique focused `main#main` target.
- Horizontal overflow, clipped content, Easy Mode 22px text, and effective 48×48 CSS-pixel target checks.
- Pre-hydration safety, live-region mutation evidence, repeated outcomes, request contracts, locale parity, and AI-off human handoff behavior.
- Normal-CSP hydration health without axe's isolated CSP bypass.

## Findings closed during the combined run

The closeout matrix found two product defects before the final run. Both were reported with exact evidence, repaired by their owning delivery leads, merged into the integration branch, and verified by the unchanged requirements:

1. Every Easy Mode route exposed `a.ss-skip-link[href="#main"]` at 47.39 CSS pixels high in both locales and viewports, below the 48-pixel floor. The shared skip-link repair was integrated at `dd13cdf`; all 48 affected route/locale/viewport observations pass in the final matrix.
2. `/concierge` in Spanish Standard and Easy modes rendered three `held_english_fallback` assistance messages without the required `available in English only` affordance. The concierge repair was integrated through `79a0e9f`; the test now requires one exact affordance for every held-English message, and both Spanish modes pass.

No automated product failures remain in the WP-031 matrix at the recorded baseline.

## Harness integrity

The closeout preserved the assertions and complete matrix. It made test synchronization observable and bounded:

- Client-rendered axe rows wait for the page heading before scanning, preventing a server shell from being mistaken for the settled route.
- Hydration-dependent controls use a scoped 15-second enabled-state wait; navigation and the overall test timeout were not inflated.
- The normal-CSP check compares against the validated configured origin instead of a hard-coded port.
- Easy Mode target diagnostics include element class, name, href, accessible text, and two-decimal dimensions.
- The broad `/help` live-announcement check returns a deterministic 503 from the assistance endpoint, exercising the real UI failure announcement without depending on tenant configuration or backend compilation latency.

No retries, skips, rule exclusions, assertion weakening, or product-code edits were used to obtain the final result.

## Evidence boundary

This document records automated browser evidence. It is not an accessibility certification and does not claim manual assistive-technology coverage. NVDA with Chrome and VoiceOver with Safari were not run as part of this closeout; those remain separate human validation activities when release policy requires them.

## Human assistive-technology evidence

The executable, currently unrun human procedure is [human-screen-reader-protocol.md](human-screen-reader-protocol.md), with the canonical [route/action/status matrix](../../tests/a11y/WP-031/human-screen-reader-matrix.json) and [evidence template](human-screen-reader-evidence-template.md). It requires NVDA + Chrome on Windows and VoiceOver + Safari on macOS across English/Spanish and Standard/Easy. Literal candidate/URL placeholders deliberately keep the binding gate red until the integrator binds and separately verifies the intended post-repair sealed descendant. The binding validator proves SHA identity and distinctness from recorded baselines, not Git chronology. Nothing in those templates upgrades the automated baseline above or claims human execution.
