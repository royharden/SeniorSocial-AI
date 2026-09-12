import { expect, it } from 'vitest';
import { schemas } from '../../../packages/contracts/src/index.ts';
import { printableHtml } from '../../../packages/notify/src/print.ts';

// what_bug_this_catches: printing fabricates freshness or executes embedded source HTML.
it('preserves locked provenance and escapes untrusted snapshot content', () => {
  const snapshot = { as_of: '2026-08-01T12:00:00.000Z', source_version: 'schedule:v7', items: [{ title: '<script>alert(1)</script>', starts_at: '2026-08-02T12:00:00Z' }] };
  expect(schemas.PrintableSchedule.safeParse(snapshot).success).toBe(true);
  const html = printableHtml(snapshot);
  expect(html).toContain(snapshot.as_of);
  expect(html).toContain(snapshot.source_version);
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
  expect(html).toContain('do not update or recall');
});

// what_bug_this_catches: a Spanish print request publishes draft Spanish or labels governed English fallback as Spanish.
it('renders EN/ES print artifacts with truthful locale, catalog, and snapshot provenance', () => {
  const snapshot = { as_of: '2026-08-01T12:00:00.000Z', source_version: 'schedule:v7', items: [] };
  const english = printableHtml(snapshot);
  expect(english).toContain('<html lang="en" data-requested-locale="en" data-render-state="english_source">');
  expect(english).toContain('data-catalog-key="notify.print.title" data-render-state="english_source"');
  expect(english).not.toContain('data-catalog-affordance=');
  expect(english).toContain('<meta name="schedule-source-version" content="schedule:v7">');
  expect(english).toContain('<meta name="schedule-source-as-of" content="2026-08-01T12:00:00.000Z">');

  const heldSpanish = printableHtml(snapshot, 'es');
  expect(heldSpanish).toContain('<html lang="en" data-requested-locale="es" data-render-state="provisional_english_fallback">');
  expect(heldSpanish).toContain('data-review-status="draft"');
  expect(heldSpanish).toContain('data-catalog-affordance="provisional_english_fallback" lang="en"> Spanish translation is awaiting review.</small>');
  expect(heldSpanish).toContain('Printable schedule');
  expect(heldSpanish).not.toContain('Horario para imprimir');
});
