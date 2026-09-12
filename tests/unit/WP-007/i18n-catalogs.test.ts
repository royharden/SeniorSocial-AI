import { describe, expect, it } from 'vitest';
import { catalogs } from '../../../packages/i18n/src/index';
import commonStatus from '../../../packages/i18n/es/common.status.json';
import profileStatus from '../../../packages/i18n/es/profile.status.json';
import shellStatus from '../../../packages/i18n/es/shell.status.json';

const namespaces = ['common', 'profile', 'shell'] as const;

describe('WP-007 bilingual catalogs', () => {
  it.each(namespaces)('%s has the same English and Spanish keys', (namespace) => {
    expect(Object.keys(catalogs.es[namespace]).sort()).toEqual(
      Object.keys(catalogs.en[namespace]).sort(),
    );
  });

  it.each([
    ['common', commonStatus],
    ['profile', profileStatus],
    ['shell', shellStatus],
  ] as const)('%s records review status for every Spanish key', (namespace, statuses) => {
    const expected = Object.keys(catalogs.es[namespace]).map((key) => `${namespace}.${key}`).sort();
    expect(Object.keys(statuses).sort()).toEqual(expected);
    expect(Object.values(statuses).every((entry) =>
      entry.status === 'draft' && entry.machine_generated && entry.critical === false,
    )).toBe(true);
  });
});
