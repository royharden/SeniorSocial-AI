#!/usr/bin/env node
/**
 * lockfile-diff.mjs — the `verify:lockfile` stage (WP-001).
 *
 * 03-parallel-build-architecture.md s4.4 and 04-tests-and-evals.md s4.2:
 * "a merge that changes `pnpm-lock.yaml` without a corresponding dependency change
 *  in the package's declared paths is a supply-chain surprise, and it is the one
 *  class the audit tools will not tell you about because the result is still a
 *  valid lockfile."
 *
 * So the rule is exactly that, and nothing more:
 *
 *   pnpm-lock.yaml changed AND no dependency declaration changed -> exit 1
 *   pnpm-lock.yaml changed alongside package.json or the root
 *   pnpm-workspace.yaml resolution policy                       -> exit 0
 *   pnpm-lock.yaml unchanged                               -> exit 0
 *
 * Workers commit nothing (03 s4.4), so "changed" is read from `git status
 * --porcelain` — staged, unstaged and untracked alike — not from `git diff`,
 * which cannot see an untracked file. `--base <sha>` additionally folds in
 * everything committed since that sha, which is how the integrator runs it on an
 * assembled candidate.
 *
 * Usage: node scripts/lockfile-diff.mjs [--base <sha>]
 */

import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
let base = process.env.BASE_SHA || null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--base') base = argv[++i];
}

function git(args) {
  // The private integration root intentionally contains many ignored/untracked
  // coordination artifacts. Keep the safety check complete instead of failing
  // Node's small default synchronous-output buffer.
  const r = spawnSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

const changed = new Set();

const porcelain = git(['status', '--porcelain', '--untracked-files=all']);
if (porcelain === null) {
  console.error('verify:lockfile: FAIL - `git status` failed; cannot establish what changed.');
  process.exit(1);
}
for (const line of porcelain.split(/\r?\n/)) {
  if (!line.trim()) continue;
  // "XY path" or "XY old -> new"
  let p = line.slice(3).trim();
  const arrow = p.indexOf(' -> ');
  if (arrow !== -1) p = p.slice(arrow + 4);
  changed.add(p.replace(/^"|"$/g, ''));
}

if (base) {
  const committed = git(['diff', '--name-only', `${base}...HEAD`]);
  if (committed === null) {
    console.error(`verify:lockfile: FAIL - base sha ${base} is not reachable in this worktree.`);
    process.exit(1);
  }
  for (const line of committed.split(/\r?\n/)) {
    if (line.trim()) changed.add(line.trim());
  }
}

const isLockfile = (p) => /(^|\/)pnpm-lock\.yaml$/.test(p);
const isManifest = (p) => /(^|\/)package\.json$/.test(p) && !p.includes('node_modules/');
const isWorkspaceResolutionPolicy = (p) => /(^|\/)pnpm-workspace\.yaml$/.test(p);

const lockChanged = [...changed].filter(isLockfile);
const manifestsChanged = [...changed].filter(isManifest);
const workspaceResolutionChanged = [...changed].filter(isWorkspaceResolutionPolicy);
const declarationsChanged = [...manifestsChanged, ...workspaceResolutionChanged];

if (lockChanged.length === 0) {
  console.log('verify:lockfile: PASS - pnpm-lock.yaml unchanged.');
  process.exit(0);
}

if (declarationsChanged.length === 0) {
  console.error('verify:lockfile: FAIL - pnpm-lock.yaml changed but no dependency declaration did.');
  console.error('  A lockfile that moves on its own is a dependency substitution that stays');
  console.error('  a valid lockfile, so `npm audit` will not report it. Re-run `pnpm install`');
  console.error('  from a clean checkout, or declare the dependency change in a manifest.');
  process.exit(1);
}

console.log(
  `verify:lockfile: PASS - pnpm-lock.yaml changed alongside ${declarationsChanged.length} dependency declaration(s): ` +
  `${declarationsChanged.join(', ')}`
);
process.exit(0);
