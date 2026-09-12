import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caregiverScopeKeys } from '../../../packages/caregiver/src/index.ts';

const contract = JSON.parse(readFileSync(new URL('../WP-002/primary-interface.snapshot.json', import.meta.url), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
};

describe('WP-017 immutable WP-002 surface', () => {
  it('implements every adopted caregiver route without inventing a guardian endpoint', () => {
    // what_bug_this_catches: implementation drift adds authority or renames the frozen activation surface.
    expect(Object.keys(contract.paths).filter(path => path.startsWith('/caregiver/')).sort()).toEqual([
      '/caregiver/invitations', '/caregiver/invitations/{token}/accept', '/caregiver/links',
      '/caregiver/links/{linkId}', '/caregiver/links/{linkId}/scopes',
    ]);
    expect(Object.keys(contract.paths).some(path => /guardian|legal.representative/iu.test(path))).toBe(false);
    expect(contract.paths['/me/caregivers']?.get).toBeDefined();
  });

  it('uses the exact frozen scope vocabulary while enforcement disables event delegation', () => {
    const schema = contract.components.schemas.ConsentScope?.properties?.key as { enum: string[] };
    expect(caregiverScopeKeys).toEqual(schema.enum);
  });
});
