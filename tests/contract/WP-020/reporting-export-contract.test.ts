/* eslint-disable @typescript-eslint/no-explicit-any,@typescript-eslint/no-unsafe-assignment,@typescript-eslint/no-unsafe-member-access,@typescript-eslint/no-unsafe-argument -- generated OpenAPI is intentionally inspected as an untyped document */
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument, schemas, validateInput } from '../../../packages/contracts/src/index.ts';

describe('WP-020 aggregate reporting export contract', () => {
  it('keeps individual and aggregate request shapes closed and disjoint', () => {
    expect(validateInput('ExportRequest', { scope: ['audit'], format: 'csv' }).success).toBe(true);
    expect(validateInput('AggregateExportRequest', {
      report_name: 'channel-activity', format: 'json', filters: { channels: ['events', 'rides'] },
    }).success).toBe(true);
    expect(validateInput('AggregateExportRequest', {
      report_name: 'channel-activity', format: 'json', filters: {}, scope: ['audit'],
    }).success).toBe(false);
    expect(validateInput('ExportRequest', {
      scope: ['audit'], format: 'csv', report_name: 'channel-activity', filters: {},
    }).success).toBe(false);
  });

  it('bounds aggregate filter channels and rejects unknown request fields', () => {
    expect(schemas.AggregateExportFilters.safeParse({
      channels: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    }).success).toBe(false);
    expect(schemas.AggregateExportFilters.safeParse({ channels: ['events', 'events'] }).success).toBe(false);
    expect(schemas.AggregateExportFilters.safeParse({ visibility: 'public' }).success).toBe(false);
  });

  it('publishes conditional idempotency, stored-format download, and truthful job metadata', () => {
    const api = generateOpenApiDocument() as Record<string, any>;
    expect(api['x-contract-version']).toBe(6);
    const create = api.paths['/admin/exports'].post;
    expect(create.requestBody.content['application/json'].schema.oneOf).toEqual([
      { $ref: '#/components/schemas/ExportRequest' },
      { $ref: '#/components/schemas/AggregateExportRequest' },
    ]);
    expect(create.parameters[0]).toMatchObject({ name: 'Idempotency-Key', required: false });
    expect(create.parameters[0].description).toContain('Required for AggregateExportRequest only');
    const download = api.paths['/admin/exports/{exportId}/download'].get;
    expect(Object.keys(download.responses).sort()).toEqual(['200', '404', '406', '409', '410']);
    expect(download.responses['200'].headers['Cache-Control'].schema.enum).toEqual(['no-store']);
    const job = api.components.schemas.ExportJob.properties;
    for (const field of [
      'report_name', 'format', 'filters', 'as_of', 'source_version', 'included_channels',
      'completeness', 'known_omissions', 'overlap_uncertainty', 'row_count', 'content_digest',
    ]) expect(job).toHaveProperty(field);
    const report = api.components.schemas.Report_.properties;
    for (const field of ['filters', 'scope', 'evidence', 'suppression_threshold']) {
      expect(report).toHaveProperty(field);
    }
    expect(report.scope.enum).toEqual(['tenant_aggregate']);
    expect(report.suppression_threshold.minimum).toBe(2);
  });
});
