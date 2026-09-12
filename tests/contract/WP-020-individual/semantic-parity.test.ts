import { describe, expect, it } from 'vitest';
import type { CanonicalIndividualExport, JsonObject } from '../../../packages/individual-exports/src/index.ts';
import { readStoredZipEntries } from '../../../packages/individual-exports/src/index.ts';
import { fullRequest, harness, resident, rows, snapshot } from '../../unit/WP-020-individual/fixtures.ts';

describe('WP-020 JSON and normalized CSV ZIP contract', () => {
  it.each([false, true])('preserves canonical rows and counts across both formats (populated consent tables: %s)', async (populated) => {
    const h = harness();
    if (populated) h.snapshots.value = snapshot(rows({
      consent_grants: [{ id: 'grant-1', scope: 'profile.read', active: true, optional: null }],
      consent_history: [{ id: 'history-1', changes: [{ before: false, after: true }], note: 'sí, "yes"\r\nnext' }],
      ai_recommendations: [{ id: 'recommendation-1', sources: ['a', 'b'], score: 0.25, text: '=1+1' }],
    }));
    const service = h.makeService();
    const jsonJob = await service.create(resident, fullRequest);
    const csvJob = await service.create(resident, { ...fullRequest, format: 'csv' });
    const json = JSON.parse(
      new TextDecoder().decode((await service.release(resident, jsonJob.id)).bytes),
    ) as unknown as CanonicalIndividualExport;
    const zipRelease = await service.release(resident, csvJob.id);
    const entries = readStoredZipEntries(zipRelease.bytes);
    const decoder = new TextDecoder();
    const manifest = JSON.parse(
      decoder.decode(entries.get('manifest.json')),
    ) as unknown as CanonicalIndividualExport['manifest'];
    expect(zipRelease.contentType).toBe('application/zip');
    expect([...entries.keys()].sort()).toEqual([
      'manifest.json', 'tables/ai_recommendations.csv', 'tables/audit_events.csv',
      'tables/consent_grants.csv', 'tables/consent_history.csv', 'tables/profile.csv',
      'tables/proposals.csv', 'tables/requests.csv',
    ]);
    expect(manifest).toEqual(json.manifest);
    for (const table of manifest.includedTables) {
      const csv = decoder.decode(entries.get(`tables/${table}.csv`));
      const records: JsonObject[] = csv.trimEnd().split('\r\n').slice(1).map((line) => {
        const encoded = line.slice(line.indexOf(',') + 1);
        const parsed: unknown = JSON.parse(encoded.slice(1, -1).replaceAll('""', '"'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid row');
        return parsed as JsonObject;
      });
      expect(records).toEqual(json.tables[table]);
      expect(records).toHaveLength(manifest.counts[table] ?? -1);
    }
  });

  it('publishes no public download path', async () => {
    const job = await harness().makeService().create(resident, fullRequest);
    expect(job.downloadUrl).toBeNull();
  });
});
