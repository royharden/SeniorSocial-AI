import { describe, expect, it } from 'vitest';
import { validateAuditInput } from '../../../packages/audit/src/index.ts';

const valid = {
  actor: 'user:11111111-1111-4111-8111-111111111101',
  action: 'flag.changed' as const,
  target: 'flag:ai.master',
  org_id: '11111111-1111-4111-8111-111111111111',
  outcome: 'allowed' as const,
  reason: 'old=true; new=false; incident response',
};

describe('WP-006 audit intent validation', () => {
  it('accepts a schema-shaped attributable flag event', () => expect(() => validateAuditInput(valid)).not.toThrow());
  it('accepts every canonical notification action without semantic remapping', () => {
    for (const action of ['notification.preferences_changed', 'notification.queued', 'notification.attempted', 'notification.suppressed'] as const) {
      expect(() => validateAuditInput({ ...valid, action, target: 'notification:synthetic-1' })).not.toThrow();
    }
  });
  it('rejects invented actions before storage', () => expect(() => validateAuditInput({ ...valid, action: 'flag.flipped' as never })).toThrow('unknown audit action'));
  it('requires reasons for flag changes and denied outcomes', () => {
    expect(() => validateAuditInput({ ...valid, reason: null })).toThrow('reason is required');
    expect(() => validateAuditInput({ ...valid, action: 'auth.signed_in', outcome: 'denied', reason: null })).toThrow('reason is required');
  });
  it('rejects multiline reasons that could smuggle resident content into logs', () => expect(() => validateAuditInput({ ...valid, reason: 'rule\nresident text' })).toThrow());
  it('accepts bounded field names and rejects content-shaped or duplicate values', () => {
    expect(() => validateAuditInput({ ...valid, fields: ['name_es', 'phone'] })).not.toThrow();
    expect(() => validateAuditInput({ ...valid, fields: ['display name'] })).toThrow('invalid audit field name');
    expect(() => validateAuditInput({ ...valid, fields: ['phone', 'phone'] })).toThrow('must be unique');
  });
});
