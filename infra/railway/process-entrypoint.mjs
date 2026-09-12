import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { requireResolvedSha } from './release-gate.mjs';

const commands = Object.freeze({
  web: ['apps/web/server.js'],
  worker: ['node_modules/tsx/dist/cli.mjs', 'packages/worker/src/main.ts'],
  migrate: ['node_modules/tsx/dist/cli.mjs', 'packages/db/src/migrate.ts', 'up'],
  seed: ['node_modules/tsx/dist/cli.mjs', 'packages/db/seed/run.ts'],
});

export function commandPlan(role, environment = process.env) {
  const selected = role ?? environment.SENIORSOCIAL_PROCESS;
  if (selected === 'migrate-seed') return [commands.migrate, commands.seed];
  const command = commands[selected];
  if (!command) throw new Error('SENIORSOCIAL_PROCESS must be web, worker, migrate, seed, or migrate-seed');
  return [command];
}

export function assertMutationAuthority(role, environment = process.env) {
  if (!['migrate', 'seed', 'migrate-seed'].includes(role)) return;
  requireResolvedSha(environment.SEALED_CANDIDATE_SHA);
  if ((role === 'seed' || role === 'migrate-seed') && environment.SENIORSOCIAL_SEED_ALLOWED !== 'true') {
    throw new Error('SENIORSOCIAL_SEED_ALLOWED=true is required for seed mutation');
  }
}

export function runRole(role, environment = process.env, spawn = spawnSync) {
  const selected = role ?? environment.SENIORSOCIAL_PROCESS;
  assertMutationAuthority(selected, environment);
  for (const [script, ...args] of commandPlan(selected, environment)) {
    const result = spawn(process.execPath, [script, ...args], { env: environment, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = runRole(process.argv[2]); } catch (error) {
    process.stderr.write(`process-entrypoint: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
