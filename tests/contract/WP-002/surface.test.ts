import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contracts } from './runtime-adapter';
const snapshot = JSON.parse(readFileSync(new URL('./primary-interface.snapshot.json', import.meta.url), 'utf8'));
const pins = JSON.parse(readFileSync(new URL('./source-pins.json', import.meta.url), 'utf8'));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const verbs = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];
describe('CK-098 adopted OpenAPI contract', () => {
  // what_bug_this_catches: generated schema changes or serialization differences silently replacing the adopted interface.
  it('CK-098 generated YAML matches adopted bytes, including comments and line endings', async () => {
    expect(sha((await contracts()).generateOpenApiYaml())).toBe(pins['openapi.yaml']);
  });
  // what_bug_this_catches: adopting the peer route map removes concierge, moderation, RSVP or kill-switch operations.
  it('CK-098 retains the complete adopted path and schema-name sets', async () => {
    const actual = (await contracts()).generateOpenApiDocument() as typeof snapshot;
    expect(Object.keys(actual.paths).sort()).toEqual(Object.keys(snapshot.paths).sort());
    for (const name of Object.keys(snapshot.components.schemas)) expect(actual.components.schemas).toHaveProperty(name);
    expect(actual.servers).toEqual(snapshot.servers);
  });
  for (const [path, raw] of Object.entries(snapshot.paths)) {
    const operations = raw as Record<string, unknown>;
    for (const method of verbs.filter((verb) => verb in operations)) {
      // what_bug_this_catches: one API operation loses its responses, role security, request schema reference, or status codes.
      it(`CK-098 /api/v1${path} ${method.toUpperCase()} preserves the adopted operation`, async () => {
        const actual = (await contracts()).generateOpenApiDocument() as typeof snapshot;
        expect(actual.paths[path][method]).toEqual(operations[method]);
      });
    }
  }
  for (const name of ['gateway-interface.ts', 'audit-event.schema.json']) {
    // what_bug_this_catches: changing normative AI or audit boundaries while copying them to runtime.
    it(`CK-098 ${name} lands byte-identical`, () => {
      const bytes = readFileSync(new URL(`../../../packages/contracts/${name}`, import.meta.url));
      expect(sha(bytes)).toBe(pins[name]);
    });
  }
});

// Preserve values/types and named design groups; exclude private descriptive planning metadata.
const tokenSemantics = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(tokenSemantics);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key === '$value' || key === '$type' || !key.startsWith('$')).map(([key, child]) => [key, tokenSemantics(child)]));
  return value;
};
// what_bug_this_catches: the initial runtime tokens silently alter adopted colors, sizes, durations, references or types.
it('WP002-TOKENS initial design token values and types match the adopted source', () => {
  const actual = JSON.parse(readFileSync(new URL('../../../packages/tokens/design-tokens.json', import.meta.url), 'utf8'));
  const expected = JSON.parse(readFileSync(new URL('./token-values.snapshot.json', import.meta.url), 'utf8'));
  expect(tokenSemantics(actual)).toEqual(expected);
});

// what_bug_this_catches: a public peer catalogue or stale skeleton bypasses the single adopted schema contract.
it('CK-098 publishes exactly the primary v6 schema set and no astraSchemas', async () => {
  const runtime = await contracts();
  expect(runtime).not.toHaveProperty('astraSchemas');
  expect(Object.keys(runtime.schemas).sort()).toEqual(Object.keys(snapshot.components.schemas).sort());
  const generated = runtime.generateOpenApiDocument() as typeof snapshot;
  expect(generated['x-contract-version']).toBe(6);
  expect(generated.components.schemas).toEqual(snapshot.components.schemas);
});

it('WP-002 v5 fixes mutation retry, version and analytics evidence semantics', async () => {
  const generated = (await contracts()).generateOpenApiDocument() as typeof snapshot;
  const requiredKey = generated.components.parameters.IdempotencyKey;
  expect(requiredKey).toMatchObject({
    name: 'Idempotency-Key', in: 'header', required: true,
    schema: { minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9._~-]{1,160}$' },
  });
  for (const [path, method] of [
    ['/conversations/{conversationId}/messages', 'post'],
    ['/conversations/{conversationId}/report', 'post'],
    ['/admin/content-pages', 'post'],
    ['/admin/faqs', 'post'],
    ['/admin/announcements', 'post'],
    ['/admin/partners', 'post'],
  ] as const) {
    const operation = generated.paths[path][method];
    expect(operation.parameters).toContainEqual({ $ref: '#/components/parameters/IdempotencyKey' });
    expect(operation.responses).toHaveProperty('409');
    expect(operation.responses).toHaveProperty('422');
  }
  expect(generated.paths['/conversations/{conversationId}/report'].post.operationId).toBe('reportConversation');
  expect(generated.paths['/admin/users/{userId}'].patch.responses).toHaveProperty('409');
  expect(generated.components.schemas.User.required).toContain('version');
  expect(generated.components.schemas.UserPatch.required).toContain('expected_version');
  expect(generated.components.schemas.AnalyticsTiles.required).toEqual(expect.arrayContaining(['as_of', 'source_version']));
});

it('WP-018 exposes explicit durable draft intent without changing legacy submit input', async () => {
  const runtime = await contracts();
  expect(runtime.schemas.IntakeSubmissionInput.safeParse({
    answers: {}, disclaimer_acknowledged: false, intent: 'save_draft',
  }).success).toBe(true);
  expect(runtime.schemas.IntakeSubmissionInput.safeParse({
    answers: {}, disclaimer_acknowledged: true,
  }).success).toBe(true);
  expect(runtime.schemas.IntakeSubmissionInput.safeParse({
    answers: {}, disclaimer_acknowledged: false, intent: 'implicit_draft',
  }).success).toBe(false);

  const generated = runtime.generateOpenApiDocument() as typeof snapshot;
  expect(generated.paths['/intake/{submissionId}'].patch.operationId).toBe('updateIntakeDraft');
  expect(generated.components.schemas.IntakeSubmission.properties.state.enum).toContain('draft');
  expect(generated.components.schemas.IntakeSubmission.properties).toHaveProperty('answers');
});
