import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
type LaneFlags = { demo: boolean; mode: string; lane: number | null; slot: number | null; profiles: string[] };
type Launcher = {
  parseFlags(argv: string[]): { command: string | undefined; flags: LaneFlags };
  demoWebStatePath(repoRoot?: string): string;
  demoWebEnvironment(env: Record<string, string>, inherited?: Record<string, string>): Record<string, string>;
  demoMaintenanceEnvironment(env: Record<string, string>, inherited?: Record<string, string>): Record<string, string>;
  demoWebCommand(port?: string): string[];
  commandMatchesDemoWeb(commandLine: string | null, token: string, scriptPath?: string): boolean;
};

// The production launcher is intentionally plain Node ESM; this cast keeps its test contract explicit.
// @ts-expect-error -- no declaration file is shipped for the executable .mjs module.
const launcher = await import('../../../scripts/lane-launch.mjs') as Launcher;

const script = resolve(import.meta.dirname, '../../../scripts/lane-launch.mjs');
const demoGuide = resolve(import.meta.dirname, '../../../docs/demo-script.md');

describe('WP-034 ss-n0 host web lifecycle', () => {
  it('keeps ordinary hybrid development distinct from reserved demo startup', () => {
    expect(launcher.parseFlags(['up', '--lane', '2'])).toEqual({
      command: 'up',
      flags: { demo: false, mode: 'hybrid', lane: 2, slot: null, profiles: [] },
    });
    expect(launcher.parseFlags(['up', '--demo', '--slot', '0']).flags).toMatchObject({
      demo: true, mode: 'hybrid', slot: 0,
    });
    expect(() => launcher.parseFlags(['up', '--demo', '--mode', 'unknown'])).toThrow(/hybrid or full-docker/u);
  });

  it('binds Next only to the fixed loopback demo port and derives runtime configuration', () => {
    // what_bug_this_catches: the detached process listens publicly, uses a builder DB, or lacks runtime-only secrets.
    expect(launcher.demoWebCommand()).toEqual([
      '--filter', '@seniorsocial/web', 'exec', 'next', 'dev',
      '--hostname', '127.0.0.1', '--port', '3100',
    ]);
    const env = launcher.demoWebEnvironment(
      { DB_PORT: '5532', WEB_PORT: '3100', MAILPIT_SMTP_PORT: '1125' },
      { CODEX_THREAD_ID: 'must-not-reach-next', SENIORSOCIAL_RUNTIME_DB_PASSWORD: 'synthetic-password' },
    );
    expect(env.HOSTNAME).toBe('127.0.0.1');
    expect(env.PORT).toBe('3100');
    expect(env.DATABASE_URL).toContain('@127.0.0.1:5532/seniorsocial');
    expect(env.SENIORSOCIAL_ORG_ID).toBe('11111111-1111-4111-8111-111111111111');
    expect(env.AUTH_TOKEN_PEPPER).toBeTruthy();
    expect(env.FIELD_ENCRYPTION_KEY).toHaveLength(64);
    expect(env.ASSISTANCE_ENCRYPTION_KEY).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(env.CODEX_THREAD_ID).toBeUndefined();
  });

  it('gives canonical reset the same local assistance key contract as demo runtime', () => {
    // what_bug_this_catches: demo:reset invokes the fail-closed seed CLI without the ss-n0 synthetic default.
    const lane = { DB_PORT: '5532' };
    const maintenance = launcher.demoMaintenanceEnvironment(lane, {});
    expect(maintenance.ASSISTANCE_ENCRYPTION_KEY).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    expect(maintenance.ASSISTANCE_ENCRYPTION_KEY).toBe(
      launcher.demoWebEnvironment(
        { ...lane, WEB_PORT: '3100', MAILPIT_SMTP_PORT: '1125' },
        {},
      ).ASSISTANCE_ENCRYPTION_KEY,
    );

    const custom = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
    expect(launcher.demoMaintenanceEnvironment(lane, { ASSISTANCE_ENCRYPTION_KEY: custom }))
      .toMatchObject({ ASSISTANCE_ENCRYPTION_KEY: custom });
    expect(launcher.demoWebEnvironment(
      { ...lane, WEB_PORT: '3100', MAILPIT_SMTP_PORT: '1125' },
      { ASSISTANCE_ENCRYPTION_KEY: custom },
    )).toMatchObject({ ASSISTANCE_ENCRYPTION_KEY: custom });
  });

  it('accepts only the exact supervisor script and unguessable ownership token', () => {
    // what_bug_this_catches: a stale or reused PID lets demo:down terminate an unrelated process.
    const token = '05546e9c-7ef0-4c4d-a87e-50c93a85264c'; // secrets-scan: allow — fixed UUID fixture
    const owned = `"C:\\Program Files\\nodejs\\node.exe" "${script}" __demo-web-child ${token} 3100`;
    expect(launcher.commandMatchesDemoWeb(owned, token, script)).toBe(true);
    expect(launcher.commandMatchesDemoWeb(owned, 'different-token', script)).toBe(false);
    expect(launcher.commandMatchesDemoWeb(`node other-script.mjs __demo-web-child ${token}`, token, script)).toBe(false);
    expect(launcher.commandMatchesDemoWeb(null, token, script)).toBe(false);
  });

  it('documents one managed host web process with the shared demo key contract', async () => {
    // what_bug_this_catches: the cold-start guide launches a second Next process on the already-owned ss-n0 port.
    const source = await import('node:fs/promises').then(fs => fs.readFile(demoGuide, 'utf8'));
    expect(source).toMatch(/pnpm demo:reset\s+pnpm demo:up/u);
    expect(source).toContain('set `ASSISTANCE_ENCRYPTION_KEY` before both `pnpm demo:reset` and `pnpm demo:up`');
    expect(source).toContain('starts and health-checks the managed, detached ss-n0 host web process');
    expect(source).toContain('same synthetic default-or-inherited `ASSISTANCE_ENCRYPTION_KEY` contract as reset');
    expect(source).not.toContain('pnpm --filter @seniorsocial/web exec next dev');
    expect(source).not.toContain('$env:PORT');
  });

  it('keys recoverable state to the canonical checkout and reserved project', () => {
    const first = mkdtempSync(join(tmpdir(), 'ss-web-state-a-'));
    const second = mkdtempSync(join(tmpdir(), 'ss-web-state-b-'));
    try {
      expect(launcher.demoWebStatePath(first)).toBe(launcher.demoWebStatePath(realpathSync.native(first)));
      expect(launcher.demoWebStatePath(first)).not.toBe(launcher.demoWebStatePath(second));
      expect(launcher.demoWebStatePath(first)).toMatch(/seniorsocial-demo-web-[a-f0-9]{20}\.json$/u);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('keeps failure rollback and exact down ordering in the executable launcher', async () => {
    // what_bug_this_catches: health failure leaves Compose or a detached web orphan behind.
    const source = await import('node:fs/promises').then(fs => fs.readFile(script, 'utf8'));
    expect(source).toContain("status = await startDemoWeb(env)");
    expect(source).toMatch(/const stopped = await stopDemoWeb\(\);\s*if \(stopped\.reason === 'stop-failed'\) return 1;/u);
    expect(source).toMatch(/function removeDemoWebArtifacts\(statePath\) \{[\s\S]*rmSync\(`\$\{statePath\}\.log`, \{ force: true \}\);/u);
    expect(source.match(/removeDemoWebArtifacts\(statePath\)/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(source).toMatch(/if \(status !== 0 && flags\.demo\) \{ await stopDemoWeb\(\); compose\(env, flags, \['down', '--remove-orphans'\]\)/u);
    expect(source).toMatch(/case 'down':[\s\S]*flags\.demo \? await stopDemoWeb\(\)[\s\S]*compose\(env, flags, \['down', '--remove-orphans'\]\)/u);
    expect(source).toContain("body?.status === 'ok' && body?.service === 'web'");
    expect(source).toMatch(/const maintenance = demoMaintenanceEnvironment\(env\);[\s\S]*runHost\(maintenance, \['exec', 'tsx', 'packages\/db\/seed\/demo\/run\.ts'\]\)/u);
    expect(source).not.toMatch(/writeEnvFile\([^)]*ASSISTANCE_ENCRYPTION_KEY/u);
    expect(source).not.toMatch(/console\.(?:log|warn|error)\([^\n]*ASSISTANCE_ENCRYPTION_KEY/u);
  });
});
