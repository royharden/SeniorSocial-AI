import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL, URL } from 'node:url';

export const unresolvedPlaceholders = Object.freeze({
  sealedCandidateSha: 'SEALED_CANDIDATE_SHA', deployedBaseUrl: 'DEPLOYED_BASE_URL', imageDigest: 'IMAGE_DIGEST',
});

const shaPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const imageReferencePattern = /^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/u;
const unresolvedPattern = /(?:PENDING|PLACEHOLDER|TO[-_ ]?DO|TBD|SEALED_CANDIDATE_SHA|DEPLOYED_BASE_URL|IMAGE_DIGEST)/iu;
const passedGateNames = Object.freeze(['health', 'smoke', 'e2e', 'a11y', 'eval', 'r24_overlay', 'local_release_diff']);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  if (unresolvedPattern.test(value)) throw new Error(`${name} contains an unresolved placeholder`);
  return value;
}

function requiredUtc(value, name) {
  const input = requiredString(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(input) || !Number.isFinite(Date.parse(input))) {
    throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
  }
  return Date.parse(input);
}

function requiredEvidence(value, name) {
  if (!digestPattern.test(String(value))) throw new Error(`${name} must be a resolved sha256 evidence digest`);
  return value;
}

function assertOrdered(earlier, later, description) {
  if (earlier > later) throw new Error(`${description} is out of order`);
}

export function requireResolvedSha(value, name = 'SEALED_CANDIDATE_SHA') {
  const candidate = requiredString(value, name);
  if (!shaPattern.test(candidate)) throw new Error(`${name} must be a resolved 40-character lowercase Git SHA`);
  return candidate;
}

export function requireResolvedDigest(value, name = 'IMAGE_DIGEST') {
  const digest = requiredString(value, name);
  if (!digestPattern.test(digest)) throw new Error(`${name} must be a resolved sha256 OCI manifest digest`);
  return digest;
}

export function requireResolvedBaseUrl(value, name = 'DEPLOYED_BASE_URL') {
  const input = requiredString(value, name);
  let url;
  try { url = new URL(input); } catch { throw new Error(`${name} must be a valid URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`${name} must be an HTTPS origin with no credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function validateCandidateCheckout({ repoRoot, sealedCandidateSha, run = execFileSync }) {
  const expected = requireResolvedSha(sealedCandidateSha);
  const head = String(run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })).trim();
  if (head !== expected) throw new Error(`HEAD ${head} does not equal SEALED_CANDIDATE_SHA ${expected}`);
  const dirty = String(run('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' })).trim();
  if (dirty) throw new Error('candidate checkout is dirty');
  return { sealedCandidateSha: expected, clean: true };
}

function assertPassedGate(name, value, deployedAt) {
  if (!value || typeof value !== 'object' || value.status !== 'PASSED') throw new Error(`gate ${name} is not PASSED`);
  if (value.failures !== 0 || value.skips !== 0) throw new Error(`gate ${name} must record zero failures and zero skips`);
  requiredEvidence(value.evidence_sha256, `gate ${name}.evidence_sha256`);
  const completedAt = requiredUtc(value.completed_at_utc, `gate ${name}.completed_at_utc`);
  assertOrdered(deployedAt, completedAt, `gate ${name}`);
  return completedAt;
}

function assertService(name, service, imageDigest, expectedHealthPath, deployedAt) {
  if (service?.status !== 'ACTIVE_AFTER_HEALTH') throw new Error(`${name} must be ACTIVE_AFTER_HEALTH`);
  if (service.health_path !== expectedHealthPath) throw new Error(`${name} health path must be exactly ${expectedHealthPath}`);
  if (!imageReferencePattern.test(String(service.image_reference)) || !service.image_reference.endsWith(`@${imageDigest}`)) {
    throw new Error(`${name} must use the release image digest without a mutable tag`);
  }
  requiredEvidence(service.health_evidence_sha256, `${name}.health_evidence_sha256`);
  const healthPassedAt = requiredUtc(service.health_passed_at_utc, `${name}.health_passed_at_utc`);
  assertOrdered(deployedAt, healthPassedAt, `${name} deployment and health activation`);
}

export function validateReleaseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('release record must be an object');
  if (record.schema_version !== 2 || record.status !== 'PASSED') throw new Error('release record is not a PASSED schema_version 2 record');
  if (!['staging', 'production'].includes(record.environment)) throw new Error('environment must be staging or production');
  const sealedCandidateSha = requireResolvedSha(record.sealed_candidate_sha, 'sealed_candidate_sha');
  const deployedBaseUrl = requireResolvedBaseUrl(record.deployed_base_url, 'deployed_base_url');
  const imageDigest = requireResolvedDigest(record.image_digest, 'image_digest');
  const imageReference = requiredString(record.image_reference, 'image_reference');
  if (!imageReferencePattern.test(imageReference) || !imageReference.endsWith(`@${imageDigest}`)) {
    throw new Error('image_reference must contain no mutable tag and be pinned to image_digest');
  }
  if (record.external_actions_authorized !== true) throw new Error('release record must name explicit external authorization');
  requiredString(record.deployer_callsign, 'deployer_callsign');
  const leakAt = requiredUtc(record.leak_scan?.completed_at_utc, 'leak_scan.completed_at_utc');
  if (record.leak_scan?.status !== 'PASSED' || record.leak_scan.candidate_sha !== sealedCandidateSha) {
    throw new Error('leak scan must pass against the sealed candidate before upload');
  }
  requiredEvidence(record.leak_scan.evidence_sha256, 'leak_scan.evidence_sha256');
  const uploadedAt = requiredUtc(record.image_uploaded_at_utc, 'image_uploaded_at_utc');
  const deployedAt = requiredUtc(record.deployed_at_utc, 'deployed_at_utc');
  assertOrdered(leakAt, uploadedAt, 'leak scan and image upload');
  assertOrdered(uploadedAt, deployedAt, 'image upload and deployment');

  assertService('services.web', record.services?.web, imageDigest, '/api/v1/health', deployedAt);
  assertService('services.worker', record.services?.worker, imageDigest, '/healthz', deployedAt);

  if (record.database?.postgres_major !== 16 || !requiredString(record.database.pgvector_extension_version, 'pgvector_extension_version')) {
    throw new Error('PostgreSQL 16 and an observed pgvector extension version are required');
  }
  const pitr = record.database.pitr;
  if (pitr?.status !== 'PASSED') throw new Error('PITR must be PASSED');
  const pitrEnabledAt = requiredUtc(pitr.enabled_at_utc, 'pitr.enabled_at_utc');
  const rangeObservedAt = requiredUtc(pitr.restore_range_observed_at_utc, 'pitr.restore_range_observed_at_utc');
  const rangeStart = requiredUtc(pitr.restore_range_start_utc, 'pitr.restore_range_start_utc');
  const rangeEnd = requiredUtc(pitr.restore_range_end_utc, 'pitr.restore_range_end_utc');
  assertOrdered(pitrEnabledAt, rangeObservedAt, 'PITR enablement and observation');
  assertOrdered(rangeStart, rangeEnd, 'PITR restore range');
  if (rangeObservedAt < rangeEnd) throw new Error('PITR restore range cannot end after it was observed');
  requiredEvidence(pitr.evidence_sha256, 'pitr.evidence_sha256');

  const dump = record.database.first_dump;
  if (dump?.status !== 'PASSED' || dump.repository_path !== null || !Number.isSafeInteger(dump.byte_length) || dump.byte_length <= 0 || dump.restore_target !== 'isolated-scratch') {
    throw new Error('first dump must be nonempty, outside the repository, and restored to isolated-scratch');
  }
  requiredEvidence(dump.sha256, 'first_dump.sha256');
  requiredEvidence(dump.restore_evidence_sha256, 'first_dump.restore_evidence_sha256');
  const dumpCreatedAt = requiredUtc(dump.created_at_utc, 'first_dump.created_at_utc');
  const dumpRestoredAt = requiredUtc(dump.restore_rehearsed_at_utc, 'first_dump.restore_rehearsed_at_utc');
  assertOrdered(dumpCreatedAt, dumpRestoredAt, 'first dump and restore rehearsal');

  const mutation = record.database.migrate_seed;
  if (mutation?.status !== 'PASSED' || mutation.migration_status !== 'PASSED' || mutation.seed_status !== 'PASSED') {
    throw new Error('migration and seed must both pass');
  }
  requiredString(record.database.migration_version, 'migration_version');
  requiredEvidence(record.database.seed_sha256, 'seed_sha256');
  requiredEvidence(mutation.evidence_sha256, 'migrate_seed.evidence_sha256');
  const migrationAt = requiredUtc(mutation.migration_completed_at_utc, 'migrate_seed.migration_completed_at_utc');
  const seedAt = requiredUtc(mutation.seed_completed_at_utc, 'migrate_seed.seed_completed_at_utc');
  assertOrdered(dumpRestoredAt, migrationAt, 'dump restore and migration');
  assertOrdered(migrationAt, seedAt, 'migration and seed');
  assertOrdered(seedAt, deployedAt, 'seed and deployment');

  let lastGateAt = deployedAt;
  for (const name of passedGateNames) lastGateAt = Math.max(lastGateAt, assertPassedGate(name, record.gates?.[name], deployedAt));
  if (record.attempt?.unexplained_failures !== 0 || record.attempt?.retries !== 0) {
    throw new Error('a PASSED record must preserve one-failure stop with zero unexplained failures and retries');
  }

  if (record.environment === 'production') {
    const promotion = record.staging_promotion;
    if (promotion?.status !== 'PASSED' || promotion.sealed_candidate_sha !== sealedCandidateSha) {
      throw new Error('production requires a passed staging promotion for the same candidate');
    }
    if (requireResolvedDigest(promotion.image_digest, 'staging_promotion.image_digest') !== imageDigest) {
      throw new Error('production image digest must exactly match the passed staging digest');
    }
    requiredEvidence(promotion.release_record_sha256, 'staging_promotion.release_record_sha256');
    const stagingPassedAt = requiredUtc(promotion.passed_at_utc, 'staging_promotion.passed_at_utc');
    assertOrdered(stagingPassedAt, migrationAt, 'staging pass and production migration');
    assertOrdered(stagingPassedAt, deployedAt, 'staging pass and production deployment');
  }

  const rollback = record.rollback;
  const rollbackDigest = requireResolvedDigest(rollback?.image_digest, 'rollback.image_digest');
  if (rollback?.status !== 'PASSED' || rollback.rehearsed !== true || rollback.restored_candidate_digest !== imageDigest) {
    throw new Error('rollback must pass and restore the promoted candidate digest');
  }
  if (rollbackDigest === imageDigest) throw new Error('rollback image digest must name a distinct known-good image');
  requiredEvidence(rollback.known_good_release_record_sha256, 'rollback.known_good_release_record_sha256');
  requiredEvidence(rollback.evidence_sha256, 'rollback.evidence_sha256');
  const rollbackStartedAt = requiredUtc(rollback.started_at_utc, 'rollback.started_at_utc');
  const rollbackHealthyAt = requiredUtc(rollback.rollback_health_passed_at_utc, 'rollback.rollback_health_passed_at_utc');
  const candidateRestoredAt = requiredUtc(rollback.candidate_restored_at_utc, 'rollback.candidate_restored_at_utc');
  const candidateHealthyAt = requiredUtc(rollback.candidate_health_passed_at_utc, 'rollback.candidate_health_passed_at_utc');
  assertOrdered(lastGateAt, rollbackStartedAt, 'gates and rollback rehearsal');
  assertOrdered(rollbackStartedAt, rollbackHealthyAt, 'rollback start and health');
  assertOrdered(rollbackHealthyAt, candidateRestoredAt, 'rollback health and candidate restore');
  assertOrdered(candidateRestoredAt, candidateHealthyAt, 'candidate restore and health');
  return { environment: record.environment, sealedCandidateSha, deployedBaseUrl, imageDigest, rollbackDigest };
}

function usage() { return 'usage: node infra/railway/release-gate.mjs candidate <repo-root> | record <release-record.json>'; }

export function main(argv = process.argv.slice(2), environment = process.env) {
  const [command, argument] = argv;
  if (command === 'candidate' && argument) {
    const result = validateCandidateCheckout({ repoRoot: argument, sealedCandidateSha: environment.SEALED_CANDIDATE_SHA });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'record' && argument) {
    const record = JSON.parse(readFileSync(argument, 'utf8'));
    process.stdout.write(`${JSON.stringify(validateReleaseRecord(record))}\n`);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) {
    process.stderr.write(`release-gate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
