#!/usr/bin/env node
/**
 * openapi-drift.mjs — the `verify:contracts` stage (WP-001).
 *
 * 03-parallel-build-architecture.md s2.1: `packages/contracts` is the RUNTIME
 * expression of `agentops/interfaces/openapi.yaml`; the zod schemas generate the
 * OpenAPI document, and this stage asserts the generated document still matches
 * the promoted interface. Only the integrator may change the interface (C9), so a
 * mismatch is always either a lane that drifted or a docket that has not been
 * applied — never something this script should reconcile.
 *
 * `packages/contracts` is WP-002's and does not exist at WP-001. The guard is the
 * same asymmetric one the rest of the gate uses:
 *
 *   packages/contracts ABSENT                          -> SKIP (loudly), exit 0
 *   PRESENT, exposes `generate:openapi`, output matches -> PASS, exit 0
 *   PRESENT, exposes `generate:openapi`, output differs -> FAIL, exit 1
 *   PRESENT but exposes no generator                    -> FAIL, exit 1
 *
 * The last case matters: a contracts package with no way to regenerate its
 * document turns this stage into a permanent no-op, which is the failure this
 * whole gate composition is written against.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = join(REPO_ROOT, 'packages', 'contracts');
const INTERFACE = join(REPO_ROOT, 'agentops', 'interfaces', 'openapi.yaml');

if (!existsSync(CONTRACTS)) {
  console.log(
    'verify:contracts: SKIP - packages/contracts not present yet (WP-002 lands it). ' +
    'This line is a standing to-do, not a pass.'
  );
  process.exit(0);
}

if (!existsSync(INTERFACE)) {
  console.error('verify:contracts: FAIL - packages/contracts exists but agentops/interfaces/openapi.yaml does not.');
  console.error('  The generated document has nothing to be compared against, so the stage cannot pass.');
  process.exit(1);
}

const pkgPath = join(CONTRACTS, 'package.json');
if (!existsSync(pkgPath)) {
  console.error('verify:contracts: FAIL - packages/contracts has no package.json.');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (!pkg.scripts || !pkg.scripts['generate:openapi']) {
  console.error('verify:contracts: FAIL - packages/contracts exposes no `generate:openapi` script.');
  console.error('  Without a generator this stage can never detect drift, and a stage that cannot');
  console.error('  fail is not a gate. Add the script; do not remove the stage.');
  process.exit(1);
}

const gen = spawnSync('pnpm', ['--filter', pkg.name || './packages/contracts', 'run', 'generate:openapi', '--', '--stdout'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (gen.status !== 0) {
  console.error('verify:contracts: FAIL - `generate:openapi` exited non-zero.');
  if (gen.stderr) console.error(gen.stderr);
  process.exit(1);
}

const normalise = (s) => s.replace(/\r\n/g, '\n').trimEnd();
const generated = normalise(gen.stdout);
const promoted = normalise(readFileSync(INTERFACE, 'utf8'));

if (generated !== promoted) {
  console.error('verify:contracts: FAIL - the generated OpenAPI document differs from agentops/interfaces/openapi.yaml.');
  console.error('  The documented contract and the enforced contract have drifted (T-4).');
  console.error('  Only the integrator changes the interface, and only from a ruled docket (C9).');
  process.exit(1);
}

console.log('verify:contracts: PASS - generated OpenAPI document matches the promoted interface.');
process.exit(0);
