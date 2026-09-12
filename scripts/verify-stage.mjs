#!/usr/bin/env node
/**
 * verify-stage.mjs — guarded stage runner for `pnpm verify` (WP-001).
 *
 * Why this exists
 * ---------------
 * The merge gate's composition is fixed (04-tests-and-evals.md s4.2) but several
 * of its stages point at directories another package has not landed yet
 * (`tests/**` belongs to the test authors, `evals/**` to WP-022, `packages/contracts`
 * to WP-002). Two wrong answers were available and both are rejected here:
 *
 *   1. `--passWithNoTests` on every runner. That makes the stage green forever,
 *      including the day somebody deletes the suite. It is the EMR-SO no-op.
 *   2. Letting the stage go red on an empty tree. That makes the scaffold's own
 *      acceptance ("pnpm verify exits 0 on an empty app") unreachable and invites
 *      the next tired session to comment the stage out.
 *
 * So the guard is asymmetric and fails closed on the dangerous case:
 *
 *   * target directory ABSENT  -> SKIP, printed loudly, exit 0.
 *     Nobody has written it yet; there is nothing to regress.
 *   * target directory PRESENT but holding zero matching files -> FAIL, exit 1.
 *     That is the deletion case, and it is exactly what a gate is for.
 *   * target directory PRESENT with matching files -> run the command, propagate
 *     its exit code unchanged. No softening flags are added.
 *
 * A SKIP line naming a directory is a standing to-do that shows up in every run's
 * output until the owning package lands. It cannot be mistaken for a pass.
 *
 * Usage
 * -----
 *   node scripts/verify-stage.mjs --name <label> --dir <path> --ext <.suffix>
 *        [--dir <path> ...] -- <command> [args...]
 *
 *   node scripts/verify-stage.mjs --name <label> --ps1 <script.ps1> -- [ps args...]
 *
 * No dependencies: this runs before `pnpm install` has necessarily finished and
 * inside the ten-minute merge budget, so it costs no module resolution.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ------------------------------------------------------------------ argv
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep === -1 ? argv : argv.slice(0, sep);
const rest = sep === -1 ? [] : argv.slice(sep + 1);

let name = 'stage';
let ps1 = null;
const dirs = [];
const exts = [];
const files = [];

for (let i = 0; i < opts.length; i += 1) {
  const a = opts[i];
  if (a === '--name') { name = opts[++i]; }
  else if (a === '--dir') { dirs.push(opts[++i]); }
  else if (a === '--ext') { exts.push(opts[++i]); }
  // --file gates on one artefact belonging to the package that OWNS this stage's
  // harness (e.g. scripts/eval-guard.ts, which WP-022 lands and which the promoted
  // promptfoo config already names as mandatory). Its absence means "not landed
  // yet", exactly like a missing directory; its presence makes the stage binding.
  else if (a === '--file') { files.push(opts[++i]); }
  else if (a === '--ps1') { ps1 = opts[++i]; }
  else { fail(`unknown option ${a}`); }
}

function fail(msg) {
  console.error(`verify:${name}: FAIL - ${msg}`);
  process.exit(1);
}

function countMatching(dirAbs) {
  let n = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === '.turbo' || entry.startsWith('.')) continue;
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (exts.length === 0 || exts.some((e) => entry.endsWith(e))) n += 1;
    }
  };
  walk(dirAbs);
  return n;
}

// -------------------------------------------------------- PowerShell mode
if (ps1) {
  const script = resolve(REPO_ROOT, ps1);
  if (!existsSync(script)) fail(`${ps1} is missing. A scanner that is not there is not a pass.`);

  // GitHub's Linux runners ship `pwsh`; this Windows host has Windows PowerShell 5.1
  // only. Resolve at run time rather than pinning one, and fail closed if neither
  // is present — a security scan that silently does not run is the failure mode
  // this whole file exists to prevent.
  const candidates = ['pwsh', 'powershell'];
  let chosen = null;
  for (const c of candidates) {
    const probe = spawnSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore', shell: false });
    if (probe.status === 0) { chosen = c; break; }
  }
  if (!chosen) fail('neither `pwsh` nor `powershell` is on PATH; cannot run the scanner.');

  const r = spawnSync(chosen, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...rest], {
    stdio: 'inherit',
    shell: false,
  });
  process.exit(r.status === null ? 1 : r.status);
}

// ------------------------------------------------------------- guard mode
if (dirs.length === 0 && files.length === 0) fail('no --dir/--file given and no --ps1; nothing to guard.');

const missing = [];
let total = 0;

for (const f of files) {
  const abs = resolve(REPO_ROOT, f);
  if (!existsSync(abs)) { missing.push(f); continue; }
  total += 1;
}

for (const d of dirs) {
  const abs = resolve(REPO_ROOT, d);
  if (!existsSync(abs)) { missing.push(d); continue; }
  const n = countMatching(abs);
  if (n === 0) {
    fail(
      `${d} exists but holds no ${exts.length ? exts.join('/') : ''} files. ` +
      'A suite that was landed and then emptied is a regression, not an empty tree.'
    );
  }
  total += n;
}

if (missing.length === dirs.length + files.length) {
  console.log(
    `verify:${name}: SKIP - ${missing.join(', ')} not present yet (owned by another package). ` +
    'This line is a standing to-do, not a pass.'
  );
  process.exit(0);
}

if (rest.length === 0) fail('no command after `--`.');

console.log(`verify:${name}: running over ${total} file(s)`);
const [cmd, ...args] = rest;
const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status === null ? 1 : r.status);
