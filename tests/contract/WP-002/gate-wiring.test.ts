import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch: string[] = [];
const expectedSha = '0f8ec80999a3942372805e1e1c5131d168c7453f90da5cfeea053fac6098cdd9';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
// pnpm nested scripts may preserve the parent's lifecycle labels. They are not child identity.
// Remove only inherited identity fields; preserve dependency/install policy and other environment settings.
function childEnvironment(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith('npm_lifecycle_') || key.toLowerCase().startsWith('npm_package_')) delete env[key];
  }
  return { ...env, CI: 'true', NO_COLOR: '1', PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false', ...extraEnv };
}
const command = (cwd: string, args: string[], extraEnv: Record<string, string> = {}) => spawnSync('pnpm', args, {
  cwd, encoding: 'utf8', shell: process.platform === 'win32', timeout: 90_000,
  env: childEnvironment(extraEnv),
});
const gate = (cwd: string) => spawnSync(process.execPath, [join(cwd, 'scripts/openapi-drift.mjs')], {
  cwd, encoding: 'utf8', timeout: 90_000, env: childEnvironment(),
});
const output = (result: ReturnType<typeof command>) => `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
const packageManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'packages/contracts/package.json'), 'utf8')) as { name: string; scripts: Record<string, string> };
function fresh(): string {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), 'ss-wp002-gates-'));
  scratch.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'packages/contracts'), { recursive: true });
  mkdirSync(join(dir, 'agentops/interfaces'), { recursive: true });
  cpSync(join(root, 'scripts/openapi-drift.mjs'), join(dir, 'scripts/openapi-drift.mjs'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@11.9.0' }));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - packages/*\nverifyDepsBeforeRun: false\n");
  return dir;
}
function fixture(mode: 'match' | 'drift' | 'failure' | 'missing'): string {
  const dir = fresh();
  const yaml = 'openapi: 3.1.0\ninfo: {title: Synthetic probe, version: 1}\npaths: {}\n';
  writeFileSync(join(dir, 'agentops/interfaces/openapi.yaml'), yaml);
  writeFileSync(join(dir, 'packages/contracts/package.json'), JSON.stringify({
    name: '@synthetic/gate-probe', private: true, type: 'module',
    scripts: mode === 'missing' ? {} : { 'generate:openapi': 'node generate.mjs' },
  }));
  const body = mode === 'failure' ? "process.stderr.write('PLANTED_GENERATOR_FAILURE'); process.exit(17);"
    : `process.stdout.write(${JSON.stringify(mode === 'drift' ? yaml.replace('3.1.0', '3.0.0') : yaml)});`;
  writeFileSync(join(dir, 'packages/contracts/generate.mjs'), body);
  return dir;
}
function copiedPackage(): string {
  const dir = fresh();
  // Black-box execution copy only: the author never inspects builder implementation.
  cpSync(join(root, 'packages/contracts'), join(dir, 'packages/contracts'), {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).some((part) => ['node_modules', '.turbo', 'dist'].includes(part)),
  });
  cpSync(join(root, 'agentops/interfaces/openapi.yaml'), join(dir, 'agentops/interfaces/openapi.yaml'));
  for (const name of ['tsconfig.base.json', 'eslint.config.mjs', 'turbo.json']) cpSync(join(root, name), join(dir, name));
  for (const relative of ['node_modules', 'packages/contracts/node_modules']) {
    const source = join(root, relative);
    if (!existsSync(source)) continue;
    const destination = join(dir, relative);
    mkdirSync(destination, { recursive: true });
    // Link installed dependencies, never the parent's pnpm workspace metadata.
    // A whole node_modules junction reuses absolute project paths and makes filters select no scratch package.
    // The root .bin launchers resolve through ../.pnpm, so expose only that dependency store as well.
    const store = join(source, '.pnpm');
    if (existsSync(store)) symlinkSync(store, join(destination, '.pnpm'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.name.startsWith('.') && entry.name !== '.bin') continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const sourceEntry = join(source, entry.name);
      // pnpm package links are relative to the original node_modules/.pnpm store.
      // Resolve them before creating the scratch junction so Windows does not
      // reinterpret the relative target beneath the temporary directory.
      const target = entry.isSymbolicLink() ? realpathSync.native(sourceEntry) : sourceEntry;
      symlinkSync(target, join(destination, entry.name), process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    // Only our mkdtemp-owned directory is removed; links are unlinked, never traversed.
    expect(resolve(dir).startsWith(resolve(realpathSync.native(tmpdir())) + (process.platform === 'win32' ? '\\' : '/'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('WP002-GATE-WIRING actual generator and package gates', () => {
  // what_bug_this_catches: a package has validators but no executable generator, or stdout includes banners/debug data.
  it('WP002-GATE-WIRING actual package generator emits exactly adopted YAML bytes', () => {
    const result = command(root, ['--fail-if-no-match', '--silent', '--filter', packageManifest(root).name, 'run', 'generate:openapi', '--', '--stdout']);
    expect(result.status, output(result)).toBe(0);
    expect(digest(result.stdout)).toBe(expectedSha);
  }, 100_000);
  // what_bug_this_catches: passing isolated generator tests hides broken root gate command wiring or pnpm banner capture.
  it('WP002-GATE-WIRING actual root drift gate passes the actual package', () => {
    const result = gate(root);
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('verify:contracts: PASS');
  }, 100_000);
  // what_bug_this_catches: generator echoes the promoted file instead of deriving the document from live validators.
  it('WP002-GATE-WIRING poisoning only the promoted source cannot change generated bytes', () => {
    const dir = copiedPackage();
    writeFileSync(join(dir, 'agentops/interfaces/openapi.yaml'), 'PLANTED_SOURCE_ECHO_TRAP');
    const result = command(dir, ['--fail-if-no-match', '--silent', '--filter', packageManifest(dir).name, 'run', 'generate:openapi', '--', '--stdout']);
    expect(result.status, output(result)).toBe(0);
    expect(digest(result.stdout)).toBe(expectedSha);
    const drift = gate(dir);
    expect(drift.status, output(drift)).toBe(1);
    expect(output(drift)).toContain('differs');
  }, 200_000);
  // what_bug_this_catches: root invocation adds package-manager stdout to a correct pure-YAML generator.
  it('WP002-GATE-WIRING root gate accepts an independently correct generator fixture', () => {
    const result = gate(fixture('match'));
    expect(result.status, output(result)).toBe(0);
    expect(output(result)).toContain('verify:contracts: PASS');
  }, 100_000);
  for (const mode of ['drift', 'failure', 'missing'] as const) {
    // what_bug_this_catches: root gate silently passes drift, swallows generator errors, or skips an existing ungeneratable package.
    it(`WP002-GATE-WIRING root gate fails closed for ${mode}`, () => {
      const result = gate(fixture(mode));
      expect(result.status, output(result)).toBe(1);
      expect(output(result)).toContain('verify:contracts: FAIL');
      expect(output(result)).toContain(mode === 'drift' ? 'differs' : mode === 'failure' ? 'exited non-zero' : 'exposes no');
    }, 100_000);
  }
  for (const task of ['typecheck', 'lint'] as const) {
    // what_bug_this_catches: contracts is absent from the root Turbo task graph despite containing runtime source.
    it(`WP002-GATE-WIRING root Turbo ${task} includes contracts`, () => {
      const result = command(root, ['exec', 'turbo', 'run', task, '--filter=./packages/contracts', '--dry=json']);
      expect(result.status, output(result)).toBe(0);
      const plan = JSON.parse(result.stdout) as { tasks: { directory?: string; task?: string; command?: string }[] };
      expect(plan.tasks.some((entry) => entry.directory?.replaceAll('\\', '/') === 'packages/contracts' && entry.task === task && typeof entry.command === 'string' && entry.command !== '<NONEXISTENT>')).toBe(true);
    }, 100_000);
    for (const subtree of ['src', 'scripts'] as const) {
    // what_bug_this_catches: declared package checks omit typed scripts/source, select no project yet return success, or never reject a real type/lint violation.
    it(`${subtree === 'scripts' ? 'WP002-TYPED-SCRIPTS' : 'WP002-GATE-WIRING'} package ${task} detects a planted ${subtree} defect after clean success`, () => {
      const dir = copiedPackage();
      const manifest = packageManifest(dir);
      const args = ['--fail-if-no-match', '--filter', manifest.name, 'run', task];
      // Observe the actual Node task process, not a successful package-manager selection/no-op or inherited root lifecycle labels.
      const probe = join(dir, '__task-proof.cjs');
      writeFileSync(probe, "if (process.env.npm_lifecycle_event) process.stderr.write('WP002_EXEC ' + JSON.stringify({ task: process.env.npm_lifecycle_event, name: process.env.npm_package_name, cwd: process.cwd(), argv: process.argv }) + '\\n');");
      const taskEnv = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require "${probe.replaceAll('\\', '/')}"` };
      const clean = command(dir, args, taskEnv);
      expect(clean.status, output(clean)).toBe(0);
      expect(manifest.scripts[task]).toBeTruthy();
      expect(output(clean)).not.toMatch(/No projects matched|No tasks were executed|No projects selected/i);
      const observations = output(clean).split('\n').filter((line) => line.startsWith('WP002_EXEC ')).map((line) => JSON.parse(line.slice('WP002_EXEC '.length)) as { task: string; name: string; cwd: string; argv: string[] });
      expect(observations, output(clean)).not.toEqual([]);
      expect(observations.some((entry) => entry.task === task && entry.name === manifest.name && realpathSync.native(entry.cwd).toLowerCase() === realpathSync.native(join(dir, 'packages/contracts')).toLowerCase() && entry.argv.some((arg) => basename(arg) === (task === 'typecheck' ? 'tsc' : 'eslint.js'))), JSON.stringify({ observations, task, package: manifest.name, expectedCwd: resolve(dir, 'packages/contracts') })).toBe(true);
      const name = task === 'typecheck' ? '__wp002_type_probe.ts' : '__wp002_lint_probe.ts';
      const defect = task === 'typecheck' ? "export const wp002TypeProbe: number = 'PLANTED_TYPE_ERROR';\n" : 'export const wp002LintProbe: any = 1;\n';
      mkdirSync(join(dir, 'packages/contracts', subtree), { recursive: true });
      writeFileSync(join(dir, 'packages/contracts', subtree, name), defect);
      const broken = command(dir, args, taskEnv);
      expect(broken.status, output(broken)).not.toBe(0);
      expect(output(broken)).toContain(name);
      expect(output(broken)).toContain(task === 'typecheck' ? 'TS2322' : 'no-explicit-any');
    }, 200_000);
    }
  }
});
