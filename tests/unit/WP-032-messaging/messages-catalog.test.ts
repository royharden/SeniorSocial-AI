import { describe, expect, it } from 'vitest';
import en from '../../../packages/i18n/en/messages.json';
import es from '../../../packages/i18n/es/messages.json';
import status from '../../../packages/i18n/es/messages.status.json';

const criticalKeys = new Set([
  'privacy.participant_only',
  'report.heading',
  'report.reason_label',
  'report.note_label',
  'report.saved',
  'block.action',
  'block.saved',
  'block.help',
]);

describe('WP-032 messaging catalogs', () => {
  it('has exact EN/ES key parity and complete non-empty copy', () => {
    // what_bug_this_catches: a messaging control or status silently falling back because its Spanish key is absent.
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en)).toHaveLength(25);
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim(), `messages.${key} English`).not.toBe('');
      expect(es[key].trim(), `messages.${key} Spanish`).not.toBe('');
      expect(es[key], `messages.${key} provisional Spanish`).not.toBe(en[key]);
    }
  });

  it('classifies consequential privacy, report, and block copy as held critical text', () => {
    // what_bug_this_catches: unreviewed Spanish safety or privacy claims being rendered as approved product guidance.
    expect(Object.keys(status).sort()).toEqual(Object.keys(en).map(key => `messages.${key}`).sort());
    for (const [qualifiedKey, entry] of Object.entries(status)) {
      const key = qualifiedKey.slice('messages.'.length);
      expect(entry.status).toBe('awaiting_review');
      expect(entry.machine_generated).toBe(true);
      expect(entry.critical).toBe(criticalKeys.has(key));
      expect(entry).not.toHaveProperty('reviewed_by');
      expect(entry).not.toHaveProperty('reviewer_qualification');
      expect(entry).not.toHaveProperty('reviewed_at');
      if (criticalKeys.has(key)) expect(entry).toHaveProperty('render_state', 'held_english_fallback');
      else expect(entry).not.toHaveProperty('render_state');
    }
  });

  it('uses the usted register in direct Spanish instructions and claims', () => {
    // what_bug_this_catches: informal second-person language leaking into a senior-facing Spanish journey.
    expect(es['privacy.participant_only']).toContain('usted');
    expect(es['composer.body_label']).toBe('Su mensaje');
    expect(es['block.saved']).toContain('usted');
    expect(es['block.help']).toContain('usted');
    expect(Object.values(es).join(' ')).not.toMatch(/\b(tu|tus|tú|puedes|intenta|vuelve)\b/iu);
  });
});
