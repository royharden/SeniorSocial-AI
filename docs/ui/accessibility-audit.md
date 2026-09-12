# Accessibility audit — WP-031

Audit baseline: `23f8cfdc597d9ccbf41d0b8512c6b3e58194281c`

Runner: Playwright 1.63.0, Chromium, `@axe-core/playwright` 4.11.1

Local origin: `http://localhost:3131`

## Scope and reproducibility

The durable audit is in `tests/a11y/WP-031`. It inventories every currently integrated `page.tsx` route and excludes API and auth handler endpoints. The matrix is 12 routes × English/Spanish × standard/Easy Mode. Axe runs at 1280×800; keyboard, skip-link, landmark, locale, announcement, and Easy Mode checks run under the normal application CSP; clipping/horizontal-scroll and Easy Mode sizing run at 1280×800 and 360×640. Only `axe.spec.ts` enables Playwright's `bypassCSP`, because axe must inject its analyzer.

Run from the coding root:

```powershell
pnpm exec playwright test --config tests/a11y/WP-031/playwright.config.ts
```

Routes: `/`, `/home`, `/settings`, `/settings/notifications`, `/help`, `/events`, `/caregiver`, `/rides`, `/preferences/confirm?mode=easy`, `/print`, `/services`, `/concierge`.

The keyboard walk derives the browser-visible tab sequence from stable native semantics, waits for the ride form's hydration-enabled submit control, excludes Next's injected dev-tools button, tabs through every product action in DOM order, requires a computed focus indicator, verifies the focused control is not horizontally clipped, then independently verifies that the first Tab reaches `a[href="#main"]`, activating it focuses one and only one `main#main`. Live-region smoke tests install a mutation recorder before application code, wait for React handlers, discard initial document-construction mutations, and exercise controlled loading results and user actions. Easy Mode requires a 22px body floor and effective 48×48 CSS-pixel targets (checkbox/radio inputs use their clickable label). No assertion is skipped or converted into a fake pass.

## Infrastructure classification

The normal-CSP health test is the boundary between shared infrastructure and product accessibility results. A wrong/unavailable dev origin, HTTP 5xx render, missing nonce CSP, hydration failure, or CSP console refusal is an **infrastructure-only failure**; it invalidates the affected product observation and must not be filed as an accessibility defect. Axe's isolated bypass is not evidence that normal application CSP failed.

### INF-01 — loopback alias is rejected by Next dev resources

- Route/matrix: `/`, EN, standard, 1280×800 (the first controlled row; the behavior applies to the shared dev origin)
- Rule: dev-origin integrity before accessibility analysis
- Evidence: with `http://127.0.0.1:3131`, Next 16.3.4 served the document but logged `Blocked cross-origin request to Next.js dev resource /_next/hmr from "127.0.0.1"` and directed the project to add `allowedDevOrigins: ['127.0.0.1']`; the initial audit navigation then timed out while waiting for dev-server idleness.
- Classification/severity: infrastructure-only / medium (invalidates an audit row; not a product accessibility defect)
- Owner: `apps/web/next.config.ts` (shared configuration; out of WP-031 scope)
- Audit disposition: the self-contained runner uses Next's advertised same-origin `http://localhost:3131`, waits for bounded `domcontentloaded` plus an explicit visible body/root instead of dev-mode network idleness, and separately asserts normal-CSP health. No shared config was changed.

## Controlled-run summary

- Discovery: 25 Playwright tests enumerate 212 route/check rows after expansion.
- Axe controlled matrix: all 48 route × locale × mode rows completed at 1280×800; 20 passed and 28 failed. English passed on all shell routes except `/caregiver`; Spanish shell rows all fail the translation-banner landmark issue; `/` and `/services` fail in every context. `/concierge` is axe-clean but fails other requirements below.
- Normal-CSP health: passed at `localhost`; INF-01 occurred only on the rejected `127.0.0.1` alias.
- Keyboard controlled matrix: all 48 route × locale × mode rows were walked. Review found that Next's dynamically injected `#next-logo` dev-tools control—not Chromium's multi-step `datetime-local` focus—caused the residual false missing-control result. A focused post-correction rerun excludes that non-product control and retains the documented landmark/skip-target failures.
- Layout controlled matrix: all 96 route × locale × mode × viewport rows executed. All four standard-mode context tests passed. All four Easy Mode context tests failed on target sizing and/or missing Easy Mode. No horizontal-scroll or clipping assertion failed.
- Static checks passed: `pnpm exec eslint tests/a11y/WP-031 --max-warnings 0` and `pnpm exec tsc --project tests/a11y/WP-031/tsconfig.json --noEmit`. The suite remains deliberately red on the documented product defects.

## Product findings

| ID | Route, mode, locale, viewport/selector | Rule | Evidence | Severity | Owning package/path |
|---|---|---|---|---|---|
| A11Y-01 | `/`; standard + Easy; EN + ES; 1280×800; `html`, `a`, `section` | axe `landmark-one-main`, `region`; skip target | No main landmark exists; the skip link points to absent `#main`; content is outside landmarks. | high | `apps/web/app/page.tsx`, `apps/web/app/layout.tsx` |
| A11Y-02 | `/services`; standard + Easy; EN + ES; 1280×800; `html`, root `a` | axe `landmark-one-main`, `region`; skip target | No main landmark exists; the root skip link has no `main#main` target. | high | `apps/web/app/services/page.tsx`, `apps/web/app/layout.tsx` |
| A11Y-03 | `/caregiver`; standard + Easy; EN + ES; 1280×800; `main[aria-labelledby="caregiver-title"]`, `#main` | axe `landmark-main-is-top-level`, `landmark-no-duplicate-main` | The page's `main` is nested inside AppShell's `main`; two main landmarks are exposed. | high | `apps/web/app/(shell)/caregiver/page.tsx` |
| A11Y-04 | `/home`, `/settings`, `/settings/notifications`, `/help`, `/events`, `/caregiver`, `/rides`, `/preferences/confirm?mode=easy`, `/print`; Easy + standard; ES; 1280×800; `.ss-translation-state` (reported as `p` on `/settings`) | axe `region` | The Spanish provisional-translation message is rendered between `header` and `main`, outside any landmark. | medium | `packages/ui/src/app-shell.tsx` |
| A11Y-05 | Every route; Easy; EN + ES; 1280×800 + 360×640; root `a[href="#main"]` | Easy Mode 48×48 target floor | The root skip link measures 133×17 CSS px on every route. It sits outside `.ss-app`, so AppShell target styling never applies. | high | `apps/web/app/layout.tsx`, `packages/ui/src/styles.css` |
| A11Y-06 | `/`, `/services`, `/concierge`; Easy; EN + ES; both viewports; `.ss-app` | Easy Mode availability and 22px body floor | `.ss-app` count is 0, `data-mode` is absent, and no Easy Mode body-size contract is applied. | high | `apps/web/app/page.tsx`, `apps/web/app/services/page.tsx`, `apps/web/app/concierge/page.tsx` |
| A11Y-07 | `/events`; Easy; EN + ES; both viewports; `select[name="time_zone"]`, `textarea[name="note"]` | Easy Mode 48×48 target floor | Desktop evidence: select 101×19 and textarea 168×36. | high | `apps/web/app/(shell)/events/page.tsx`, `packages/ui/src/styles.css` |
| A11Y-08 | `/rides`; Easy; EN + ES; both viewports; route selects and checkbox labels | Easy Mode 48×48 target floor | Desktop selects measure 97–277×19; multiple effective checkbox-label targets measure 30px high. | high | `apps/web/app/(shell)/rides/ride-request-form.tsx`, `packages/ui/src/styles.css` |
| A11Y-09 | `/caregiver`; Easy; EN + ES; both viewports; permission checkbox labels | Easy Mode 48×48 target floor | Effective checkbox-label targets measure 30px high (for example `view_schedule` 200×30 and `read_back_confirmed` 576×30). | high | `apps/web/app/(shell)/caregiver/page.tsx`, `packages/ui/src/styles.css` |
| A11Y-10 | `/services`; Easy; EN + ES; both viewports; `#service-query`, search button | Easy Mode 48×48 target floor | Desktop input is 1264×34 and button is 1264×21; the route has no AppShell target tokens. | high | `apps/web/app/services/page.tsx` |
| A11Y-11 | `/concierge`; Easy; EN + ES; both viewports; language/start buttons | Easy Mode 48×48 target floor | Desktop buttons measure 60×21, 64×21, and 44×21; the route has no AppShell target tokens. | high | `apps/web/app/concierge/page.tsx` |
| A11Y-12 | `/`, `/settings/notifications`, `/events`, `/caregiver`, `/rides`, `/print`, `/concierge`; ES; both modes; primary page content | locale parity | The page components contain only English copy or initialize their own locale to EN; an ES cookie changes the shell/document language but not the page content. | high | respective `apps/web/app/**/page.tsx` files; `/concierge` local state in `apps/web/app/concierge/page.tsx` |
| A11Y-13 | `/concierge`; both modes/locales; start action and answer section | live status announcement | A successful Start replaces controls without a pre-existing live/status region; the answer live region is created already populated. The durable mutation smoke test requires either success or failure outcome to be announced. | high | `apps/web/app/concierge/page.tsx` |

Product code was intentionally not changed by WP-031. Fixes should retain these assertions; failures must not be silenced by skips, exclusions, or reduced matrices.

## Evidence gaps blocking WP-031 completion

The automated mutation tests prove that selected live containers change after controlled results; they are not a screen reader. An executable [human screen-reader protocol](human-screen-reader-protocol.md), [route/action/status matrix](../../tests/a11y/WP-031/human-screen-reader-matrix.json), and [evidence template](human-screen-reader-evidence-template.md) now define the missing observations, but all eight platform × language × mode runs remain `not_run` and the future sealed candidate/URL remain unbound. The assigned protocol uses VoiceOver + Safari on macOS and explicitly records that the retained §9.2 planning sentence named iOS. The six-journey virtual-screen-reader regression and per-route accessibility-tree snapshots in the separate machine-layer requirement also have not been added. WP-031 therefore remains an evidence-producing audit candidate, not a completed accessibility gate or certification.
