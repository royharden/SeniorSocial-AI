import { describe, expect, it } from 'vitest';
import { catalogs, resolveCatalogMessage, type CatalogKey } from '../../../packages/i18n/src/catalogs';

const criticalKeys = [
  'privacy.participant_only',
  'report.heading',
  'report.reason_label',
  'report.note_label',
  'report.saved',
  'block.action',
  'block.saved',
  'block.help',
] as const satisfies readonly CatalogKey<'messages'>[];

describe('WP-016 approval-aware critical messaging copy', () => {
  it('holds every unapproved critical Spanish key in English with a visible affordance', () => {
    // what_bug_this_catches: one privacy, report, or block claim bypassing the approval gate while adjacent copy falls back safely.
    for (const key of criticalKeys) {
      expect(resolveCatalogMessage({ locale: 'es', namespace: 'messages', key })).toMatchObject({
        text: catalogs.en.messages[key],
        requestedLocale: 'es',
        renderedLocale: 'en',
        namespace: 'messages',
        key,
        reviewStatus: 'awaiting_review',
        critical: true,
        machineGenerated: true,
        renderState: 'held_english_fallback',
        fallbackReason: 'critical_not_approved',
        affordance: 'available in English only',
      });
    }
  });

  it('keeps the same critical keys as ordinary English source text without a fallback affordance', () => {
    // what_bug_this_catches: the Spanish hold marker leaking into the normal English messaging journey.
    for (const key of criticalKeys) {
      expect(resolveCatalogMessage({ locale: 'en', namespace: 'messages', key })).toMatchObject({
        text: catalogs.en.messages[key],
        requestedLocale: 'en',
        renderedLocale: 'en',
        namespace: 'messages',
        key,
        renderState: 'english_source',
        fallbackReason: null,
        affordance: null,
      });
    }
  });
});
