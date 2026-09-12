import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import policy from '../../../packages/i18n/es/catalog-policy.json';

const root = resolve(import.meta.dirname, '../../..');
const englishRoot = resolve(root, 'packages/i18n/en');
const spanishRoot = resolve(root, 'packages/i18n/es');
const normativeStatuses = new Set(['draft', 'awaiting_review', 'approved', 'invalidated']);

type StatusEntry = {
  status: string; source_version: string; critical: boolean; machine_generated: boolean;
  render_state?: string; reviewed_by?: string; reviewer_qualification?: string; reviewed_at?: string;
};

function load(directory: string, name: string): Record<string, string> {
  return JSON.parse(readFileSync(resolve(directory, name), 'utf8')) as Record<string, string>;
}
function loadStatus(namespace: string): Record<string, StatusEntry> {
  return JSON.parse(readFileSync(resolve(spanishRoot, `${namespace}.status.json`), 'utf8')) as Record<string, StatusEntry>;
}
function isCritical(namespace: string, key: string): boolean {
  return namespace === 'assistance'
    || (namespace === 'rides' && key.startsWith('status.'))
    || (namespace === 'caregiver' && (key.startsWith('consent.') || key.startsWith('read_back.')))
    || (namespace === 'intake' && key.startsWith('disclaimer.'))
    || (namespace === 'messages' && [
      'privacy.participant_only', 'report.heading', 'report.reason_label', 'report.note_label',
      'report.saved', 'block.action', 'block.saved', 'block.help',
    ].includes(key));
}
function expectValidStatus(entry: StatusEntry): void {
  expect(normativeStatuses.has(entry.status)).toBe(true);
  const evidence = [entry.reviewed_by, entry.reviewer_qualification, entry.reviewed_at];
  const present = evidence.filter(value => value !== undefined).length;
  const expectCompleteEvidence = () => {
    expect(entry.reviewed_by?.trim().length).toBeGreaterThan(0);
    expect(entry.reviewer_qualification?.trim().length).toBeGreaterThan(0);
    expect(Date.parse(entry.reviewed_at ?? '')).not.toBeNaN();
  };
  if (entry.status === 'approved') {
    expect(present).toBe(3);
    expectCompleteEvidence();
  } else if (entry.status === 'invalidated') {
    expect([0, 3]).toContain(present);
    if (present === 3) expectCompleteEvidence();
  } else {
    expect(present).toBe(0);
  }
}

describe('WP-032 Spanish review status', () => {
  const names = readdirSync(englishRoot).filter(name => name.endsWith('.json')).sort();

  it('binds complete status metadata to every Spanish key and the mechanical critical classification', () => {
    // what_bug_this_catches: a critical provisional translation being rendered as if a qualified reviewer approved it.
    for (const name of names) {
      const namespace = name.replace(/\.json$/u, '');
      const spanish = load(spanishRoot, name);
      const statuses = loadStatus(namespace);
      const source = policy.current_source_namespaces[namespace as keyof typeof policy.current_source_namespaces];
      expect(Object.keys(statuses).sort()).toEqual(Object.keys(spanish).map(key => `${namespace}.${key}`).sort());
      for (const [qualifiedKey, entry] of Object.entries(statuses)) {
        const key = qualifiedKey.slice(namespace.length + 1);
        expect(entry.source_version).toBe(source.source_version);
        expect(entry.critical).toBe(isCritical(namespace, key));
        expectValidStatus(entry);
        if (entry.critical && entry.status !== 'approved') {
          expect(entry.render_state).toBe('held_english_fallback');
        } else if (!entry.critical) {
          expect(entry.render_state).toBeUndefined();
        }
      }
    }
  });

  it('contains complete non-empty Spanish copy without silent English fallback on ordinary keys', () => {
    // what_bug_this_catches: a missing Spanish key or copied English sentence silently reaching a localized surface.
    const allowedIdentical = new Set(policy.approved_source_identical_values.map(entry => entry.key));
    for (const name of names) {
      const namespace = name.replace(/\.json$/u, '');
      const english = load(englishRoot, name);
      const spanish = load(spanishRoot, name);
      expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(spanish)) {
        expect(value.trim().length).toBeGreaterThan(0);
        if (!isCritical(namespace, key) && !allowedIdentical.has(`${namespace}.${key}`)) expect(value).not.toBe(english[key]);
      }
    }
  });

  it('uses only normative states and requires WP-021 review evidence for approved critical copy', () => {
    // what_bug_this_catches: conflating review status with machine provenance or losing retained evidence on invalidation.
    expect(Object.keys(policy.review_status_contract).sort()).toEqual(['approved', 'awaiting_review', 'draft', 'invalidated']);
    expect(policy.review_status_contract.approved.requires).toEqual(['reviewed_by', 'reviewer_qualification', 'reviewed_at']);
    expect(policy.review_status_contract.draft).not.toHaveProperty('machine_generated');
    expect(policy.review_status_contract.awaiting_review).not.toHaveProperty('machine_generated');
    expect(policy.review_status_contract.approved).not.toHaveProperty('machine_generated');
    expect(policy.review_status_contract.invalidated.review_evidence).toBe('optional_complete_set');
    expect(policy.critical_fallback).toMatchObject({ render_state: 'held_english_fallback', affordance: 'available in English only' });
    expect(() => expectValidStatus({ status: 'human_reviewed', source_version: 'sha256:invalid', critical: true, machine_generated: false })).toThrow();
    expect(() => expectValidStatus({ status: 'approved', source_version: 'sha256:valid', critical: true, machine_generated: true })).toThrow();
    expect(() => expectValidStatus({
      status: 'approved', source_version: 'sha256:valid', critical: true, machine_generated: true,
      reviewed_by: 'Reviewer', reviewer_qualification: 'Qualified Spanish reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    })).not.toThrow();
    expect(() => expectValidStatus({
      status: 'draft', source_version: 'sha256:valid', critical: false, machine_generated: false, reviewed_by: 'Reviewer',
    })).toThrow();
    expect(() => expectValidStatus({
      status: 'invalidated', source_version: 'sha256:valid', critical: true, machine_generated: false,
      reviewed_by: 'Reviewer', reviewer_qualification: 'Qualified Spanish reviewer', reviewed_at: '2026-09-10T20:00:00Z',
    })).not.toThrow();
    expect(() => expectValidStatus({
      status: 'invalidated', source_version: 'sha256:valid', critical: true, machine_generated: false, reviewed_by: 'Reviewer',
    })).toThrow();
    expect(() => expectValidStatus({
      status: 'draft', source_version: 'sha256:valid', critical: true, machine_generated: false, render_state: 'held_english_fallback',
    })).not.toThrow();
  });
});
