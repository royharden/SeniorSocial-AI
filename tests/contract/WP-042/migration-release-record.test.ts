import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateReleaseRecord } from '../../../infra/railway/release-gate.mjs';

const root = new URL('../../../', import.meta.url);
const dockerfile = readFileSync(new URL('infra/docker/Dockerfile', root), 'utf8');
const contract = JSON.parse(readFileSync(new URL('infra/railway/deployment-contract.json', root), 'utf8')) as any;
const template = JSON.parse(readFileSync(new URL('infra/railway/release-record.template.json', root), 'utf8')) as any;
const runbook = readFileSync(new URL('docs/railway-runbook.md', root), 'utf8');

function validRecord() {
  const digest = `sha256:${'d'.repeat(64)}`;
  const evidence = `sha256:${'9'.repeat(64)}`;
  const imageReference = `example.invalid/seniorsocial@${digest}`;
  const gate = { status: 'PASSED', failures: 0, skips: 0, completed_at_utc: '2026-09-11T12:10:00Z', evidence_sha256: evidence };
  return {
    ...template,
    status: 'PASSED', environment: 'production', sealed_candidate_sha: 'e'.repeat(40),
    deployed_base_url: 'https://example.invalid', image_digest: digest,
    image_reference: imageReference, image_uploaded_at_utc: '2026-09-11T11:10:00Z',
    deployed_at_utc: '2026-09-11T12:00:00Z', deployer_callsign: 'operator',
    services: {
      web: { status: 'ACTIVE_AFTER_HEALTH', image_reference: imageReference, health_path: '/api/v1/health', health_passed_at_utc: '2026-09-11T12:05:00Z', health_evidence_sha256: evidence },
      worker: { status: 'ACTIVE_AFTER_HEALTH', image_reference: imageReference, health_path: '/healthz', health_passed_at_utc: '2026-09-11T12:05:00Z', health_evidence_sha256: evidence },
    },
    leak_scan: { status: 'PASSED', completed_at_utc: '2026-09-11T11:00:00Z', candidate_sha: 'e'.repeat(40), evidence_sha256: evidence },
    database: {
      postgres_major: 16, pgvector_extension_version: '0.8.1',
      migration_version: '0190_wp-011_concierge_conversations.sql', seed_sha256: `sha256:${'1'.repeat(64)}`,
      pitr: { status: 'PASSED', enabled_at_utc: '2026-09-11T10:00:00Z', restore_range_observed_at_utc: '2026-09-11T11:00:00Z', restore_range_start_utc: '2026-09-11T10:00:00Z', restore_range_end_utc: '2026-09-11T10:55:00Z', evidence_sha256: evidence },
      first_dump: { status: 'PASSED', created_at_utc: '2026-09-11T10:30:00Z', byte_length: 2048, sha256: `sha256:${'2'.repeat(64)}`, repository_path: null, restore_target: 'isolated-scratch', restore_rehearsed_at_utc: '2026-09-11T10:45:00Z', restore_evidence_sha256: evidence },
      migrate_seed: { status: 'PASSED', migration_status: 'PASSED', migration_completed_at_utc: '2026-09-11T11:40:00Z', seed_status: 'PASSED', seed_completed_at_utc: '2026-09-11T11:45:00Z', evidence_sha256: evidence },
    },
    gates: Object.fromEntries(Object.keys(template.gates).map((name) => [name, { ...gate }])),
    attempt: { unexplained_failures: 0, retries: 0 },
    staging_promotion: { status: 'PASSED', sealed_candidate_sha: 'e'.repeat(40), image_digest: digest, passed_at_utc: '2026-09-11T11:30:00Z', release_record_sha256: evidence },
    rollback: { status: 'PASSED', image_digest: `sha256:${'f'.repeat(64)}`, known_good_release_record_sha256: evidence, started_at_utc: '2026-09-11T12:20:00Z', rollback_health_passed_at_utc: '2026-09-11T12:21:00Z', restored_candidate_digest: digest, candidate_restored_at_utc: '2026-09-11T12:22:00Z', candidate_health_passed_at_utc: '2026-09-11T12:23:00Z', rehearsed: true, evidence_sha256: evidence },
    external_actions_authorized: true,
  };
}

describe('WP-042 migration and release contract', () => {
  it('keeps the unresolved template fail-closed', () => {
    expect(template.sealed_candidate_sha).toBe('SEALED_CANDIDATE_SHA');
    expect(template.deployed_base_url).toBe('DEPLOYED_BASE_URL');
    expect(template.image_digest).toBe('IMAGE_DIGEST');
    expect(() => validateReleaseRecord(template)).toThrow();
  });

  it('accepts only a fully evidenced, digest-pinned, zero-skip release record', () => {
    const record = validRecord();
    expect(validateReleaseRecord(record)).toMatchObject({
      environment: 'production', sealedCandidateSha: 'e'.repeat(40), imageDigest: record.image_digest,
    });
    record.gates.a11y.skips = 1;
    expect(() => validateReleaseRecord(record)).toThrow(/zero failures and zero skips/u);
  });

  it('accepts a passed staging record without pretending production promotion occurred', () => {
    const record = validRecord();
    record.environment = 'staging';
    record.staging_promotion = null;
    expect(validateReleaseRecord(record).environment).toBe('staging');
  });

  it('rejects placeholder evidence even when every status says PASSED', () => {
    const record = validRecord();
    record.gates.e2e.evidence_sha256 = 'PENDING';
    expect(() => validateReleaseRecord(record)).toThrow(/evidence digest/u);
  });

  it('rejects a mutable tag and a service digest that differs from the record', () => {
    const record = validRecord();
    record.image_reference = `example.invalid/seniorsocial:latest@${record.image_digest}`;
    expect(() => validateReleaseRecord(record)).toThrow(/mutable tag/u);
    const wrongService = validRecord();
    wrongService.services.worker.image_reference = `example.invalid/seniorsocial@sha256:${'a'.repeat(64)}`;
    expect(() => validateReleaseRecord(wrongService)).toThrow(/release image digest/u);
  });

  it('rejects production when the staging digest or candidate differs', () => {
    const wrongDigest = validRecord();
    wrongDigest.staging_promotion.image_digest = `sha256:${'a'.repeat(64)}`;
    expect(() => validateReleaseRecord(wrongDigest)).toThrow(/exactly match/u);
    const wrongSha = validRecord();
    wrongSha.staging_promotion.sealed_candidate_sha = 'a'.repeat(40);
    expect(() => validateReleaseRecord(wrongSha)).toThrow(/same candidate/u);
    const promotedLate = validRecord();
    promotedLate.staging_promotion.passed_at_utc = '2026-09-11T11:50:00Z';
    expect(() => validateReleaseRecord(promotedLate)).toThrow(/staging pass and production migration/u);
  });

  it('requires exact web health gating and Active only after health', () => {
    const wrongPath = validRecord();
    wrongPath.services.web.health_path = '/health';
    expect(() => validateReleaseRecord(wrongPath)).toThrow(/exactly \/api\/v1\/health/u);
    const activatedEarly = validRecord();
    activatedEarly.services.web.health_passed_at_utc = '2026-09-11T11:59:59Z';
    expect(() => validateReleaseRecord(activatedEarly)).toThrow(/health activation is out of order/u);
  });

  it('rejects step reordering and a passed record that hides retries', () => {
    const reordered = validRecord();
    reordered.image_uploaded_at_utc = '2026-09-11T10:59:00Z';
    expect(() => validateReleaseRecord(reordered)).toThrow(/out of order/u);
    const retried = validRecord();
    retried.attempt.retries = 1;
    expect(() => validateReleaseRecord(retried)).toThrow(/one-failure stop/u);
  });

  it('requires explicit migrate-then-seed evidence before deployment', () => {
    const record = validRecord();
    record.database.migrate_seed.seed_completed_at_utc = '2026-09-11T11:35:00Z';
    expect(() => validateReleaseRecord(record)).toThrow(/migration and seed is out of order/u);
    const skipped = validRecord();
    skipped.database.migrate_seed.seed_status = 'SKIPPED';
    expect(() => validateReleaseRecord(skipped)).toThrow(/migration and seed must both pass/u);
  });

  it('requires a concrete PITR restore range and nonempty isolated dump restore', () => {
    const badRange = validRecord();
    badRange.database.pitr.restore_range_end_utc = '2026-09-11T11:01:00Z';
    expect(() => validateReleaseRecord(badRange)).toThrow(/cannot end after/u);
    const emptyDump = validRecord();
    emptyDump.database.first_dump.byte_length = 0;
    expect(() => validateReleaseRecord(emptyDump)).toThrow(/nonempty/u);
  });

  it('requires pgvector, PITR restore range, first dump restore, and distinct digest rollback', () => {
    expect(contract.database.postgres_major).toBe(16);
    expect(contract.database.image).toBeNull();
    expect(contract.database.required_live_probes.join('\n')).toMatch(/vector[\s\S]*pitr status[\s\S]*pg_dump[\s\S]*pg_restore/iu);
    const record = validRecord();
    record.rollback.image_digest = record.image_digest;
    expect(() => validateReleaseRecord(record)).toThrow(/distinct known-good image/u);
  });

  it('rejects ambiguous rollback evidence and missing candidate restoration', () => {
    const record = validRecord();
    record.rollback.known_good_release_record_sha256 = null;
    expect(() => validateReleaseRecord(record)).toThrow(/known_good_release_record/u);
    const notRestored = validRecord();
    notRestored.rollback.restored_candidate_digest = `sha256:${'a'.repeat(64)}`;
    expect(() => validateReleaseRecord(notRestored)).toThrow(/restore the promoted candidate/u);
  });

  it('builds one non-root release target containing web, worker, and migration entrypoints', () => {
    expect(dockerfile).toContain('FROM base AS release');
    expect(dockerfile).toContain('COPY --from=build --chown=node:node /app/packages ./packages');
    expect(dockerfile).toContain('CMD ["node", "infra/railway/process-entrypoint.mjs"]');
    expect(dockerfile.indexOf('USER node', dockerfile.indexOf('FROM base AS release'))).toBeGreaterThan(-1);
    expect(dockerfile).toContain('/api/v1/health');
    expect(dockerfile).toContain('/healthz');
  });

  it('binds smoke/e2e/a11y/eval/R-24 and local diff while exposing the real remote-suite blocker', () => {
    for (const gate of ['health', 'smoke', 'e2e', 'a11y', 'eval', 'r24_overlay', 'local_release_diff']) {
      expect(template.gates).toHaveProperty(gate);
    }
    expect(runbook).toMatch(/current canonical\s+credentialed journey setup creates a disposable local database/u);
    expect(runbook).toMatch(/deployed e2e\/a11y comparison remains blocked/u);
  });
});
