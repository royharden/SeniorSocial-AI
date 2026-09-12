# Accessibility

Status: **shared accessibility system built; WP-031 hardening remains open**. The target is WCAG 2.2 AA plus a senior-focused Easy Mode, but current evidence is not a certification.

## Built foundations

- Semantic app shell with navigation landmarks, `main#main`, language metadata, fieldsets/legends, pressed-state preference buttons, and status regions.
- Standard and Easy display modes plus English and Spanish preferences. Within the shared shell, Easy Mode uses one-column cards, a persistent help bar, 48px minimum targets, larger spacing/type, and higher contrast. Pages outside the shell do not automatically inherit its help navigation. Both help-bar links open `/help`; the label “Call a person” does not initiate a telephone call.
- Atkinson Hyperlegible-first font stack, design-token color roles, visible two-band focus, reduced-motion handling, and forced-colors focus behavior.
- Typed/tapped equivalents are required for voice enhancements. AI-off paths remain ordinary forms, links, lists, and staff APIs; dashboard queue decision controls are unfinished.
- Print has a dedicated route and worker path; notification preferences include non-digital alternatives.

## Measured checks

`tests/a11y/WP-031` runs the shared route matrix in English/Spanish and Standard/Easy modes. It checks axe findings, keyboard order and visible focus, first-focus skip navigation, clipping/horizontal scroll at multiple viewports, Easy Mode 48×48 targets, Spanish content change, and live announcements for asynchronous results.

These tests are meaningful evidence, but WP-031 remains in hardening. Automated tools do not prove plain-language quality, screen-reader usability, cognitive load, zoom/reflow in every browser, or usability with tremor/low vision.

## Authoring requirements

- Use headings in order, explicit labels, native controls, and short instructions.
- Never rely on color, position, icon, placeholder, or disabled styling as the only meaning.
- Keep error text adjacent and programmatically associated; announce async success/failure without moving focus unexpectedly.
- Preserve keyboard operation, visible focus, 200% zoom/reflow, reduced motion, and 48px Easy Mode targets.
- Keep the human/help route visible when AI is off, refused, or unavailable.
- Write quick-start material in large-print form: short lines/steps, plain words, generous spacing, and a 200% browser-zoom instruction.

## Gaps before release

Complete WP-031 across every integrated route, run manual keyboard and screen-reader passes, test browser zoom/reflow and print output, review English/Spanish plain language with representative users, and record remaining defects in the accessibility audit owned separately from this document.

## Source anchors

`packages/tokens/design-tokens.json`; `packages/tokens/theme.css`; `packages/ui/src/styles.css`; `packages/ui/src/app-shell.tsx`; `packages/ui/src/preferences.ts`; `tests/a11y/WP-031`; `apps/web/app/(shell)`; `agentops/build/board.csv`.
