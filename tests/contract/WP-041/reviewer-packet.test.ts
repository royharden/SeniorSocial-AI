import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { demoAccounts, DEMO_FIXTURE_VERSION } from '../../../packages/db/seed/demo/data.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const manifest = JSON.parse(read('docs/demo/packet-manifest.json')) as {
  recordingStatus: string;
  recordingGate: string;
  runnable: boolean;
  readinessBlockers: { id: string; reason: string }[];
  credentialedCloseout: {
    status: string; command: string; passed: number; failed: number; skipped: number; duration: string;
    composition: {
      credentialedFullPass: number; crossModuleActions: number; controlledApprovals: number;
      spanishStandardEasyActions: number; shippedPagesChecked: number;
    };
    scope: string; provenanceCommit: string; adoptedCommit: string; integrationCommit: string;
  };
  captureGate: {
    status: string; blockedBy: string | null; commands: string[]; requiredCredentialedEnvironment: string[];
    evidenceFields: string[]; stopConditions: string[];
  };
  captureEvidence: {
    scope: string; sealedApplicationSha: string; integratedReceiptCommit: string; receiptPath: string;
    credentialedCommand: string; credentialedPassed: number; credentialedFailed: number;
    credentialedSkipped: number; credentialedDuration: string; fixtureVersion: string;
    staffQueueHttpStatus: number; adminQueueHttpStatus: number; recordingStartedAt: string;
    recordingEndedAt: string; wallClockSeconds: number; mediaContainerSeconds: number;
    mediaFile: string; mediaSha256: string; capturedBy: string; teardownStatus: string;
    excludedDiagnostics: string[];
  };
  webStart: {
    command: string; bindAddress: string; port: number; healthPath: string;
    healthStatus: string; detached: boolean; downCommand: string; coldRehearsed: boolean;
  };
  fixtureVersion: string;
  journeyFixtures: {
    caregiverLinkId: string; caregiverState: string; preGrantedScopeCount: number; readBackCount: number;
    fullEventId: string; capacity: number; attendingCount: number; waitlistedCount: number;
  };
  aiOffFixture: {
    orgFlags: Record<'ai.master' | 'ai.concierge', boolean>;
    effective: Record<'ai.master' | 'ai.concierge', boolean>;
    aiEventCount: number;
    nativePages: string[];
  };
  expiry: { accountCodeExpiresAt: string; codeUse: string; sessionLifetimeHours: number };
  maximumSeconds: number;
  plannedSeconds: number;
  baseUrls: { web: string; mailpit: string; adminer: string };
  criteria: { id: string; source: string }[];
  accounts: { role: string; name: string; userId: string; code: string }[];
  routes: { path: string; kind: string; source: string }[];
  segments: { id: string; seconds: number; criteria: string[] }[];
  knownLimitations: string;
};

const ownedDocs = [
  'docs/demo/packet-manifest.json',
  'docs/demo/storyboard.md',
  'docs/demo/known-limitations.md',
  'docs/reviewer-access.md',
];

function assertHumanAccess(packet: string) {
  const accountRows = packet.split(/\r?\n/u).filter(line => line.includes('| `[SYNTHETIC]'));
  expect(accountRows).toHaveLength(manifest.accounts.length);
  for (const [index, account] of manifest.accounts.entries()) {
    const row = accountRows[index] ?? '';
    expect(row).toContain(`\`${account.name}\``);
    expect(row).toContain(`\`${account.userId}\``);
    expect(row).toContain(`\`${account.code}\``);
  }
  assertHumanRoutes(packet);
}

function assertHumanRoutes(packet: string) {
  const allowed = new Set(manifest.routes.map(route => route.path));
  for (const token of packet.matchAll(/`([^`]+)`/gu)) {
    const value = token[1] ?? '';
    if (value.startsWith('/') && value !== '/') expect(allowed.has(value), value).toBe(true);
    for (const url of value.matchAll(/http:\/\/localhost:\d+(\/[^\s]*)?/gu)) {
      const parsed = new URL(url[0]);
      expect(Object.values(manifest.baseUrls)).toContain(parsed.origin);
      if (parsed.pathname !== '/') expect(allowed.has(parsed.pathname), parsed.pathname).toBe(true);
    }
  }
}

function assertCompletePrivateLocal(document: string) {
  expect(document).toMatch(/Runnable:\s*true/iu);
  expect(document).toMatch(/private-local/iu);
  expect(document).toContain(manifest.captureEvidence.sealedApplicationSha);
  expect(document).toContain(manifest.captureEvidence.integratedReceiptCommit);
  expect(document).toContain(manifest.captureEvidence.mediaFile);
  expect(document).toContain(manifest.captureEvidence.mediaSha256);
  expect(document).toContain(manifest.captureEvidence.mediaContainerSeconds.toFixed(3));
  expect(document).toContain(manifest.captureEvidence.wallClockSeconds.toFixed(3));
  expect(document).not.toMatch(/No recording (?:yet|has been made or supplied)|recording remains (?:separate and )?pending|Runnable:\s*false/iu);
  expect(document).toContain('Prose and screenshots never substitute');
  expect(document).toMatch(/(?:not|do not treat)[^.\n]*(?:public|deployment)/iu);
  expect(document).toMatch(/accessibility certification/iu);
}

describe('WP-041 reviewer packet contract', () => {
  it('uses only integrated routes and exact synthetic account identifiers', () => {
    // what_bug_this_catches: a stale route or hand-copied reviewer code makes the first tour step fail.
    const integratedRoutes = new Map([
      ['/auth/demo-code', 'apps/web/app/(auth)/auth/demo-code/route.ts'],
      ['/api/v1/health', 'apps/web/app/api/v1/health/route.ts'],
      ['/home', 'apps/web/app/(shell)/home/page.tsx'],
      ['/services', 'apps/web/app/services/page.tsx'],
      ['/concierge', 'apps/web/app/concierge/page.tsx'],
      ['/events', 'apps/web/app/(shell)/events/page.tsx'],
      ['/rides', 'apps/web/app/(shell)/rides/page.tsx'],
      ['/help', 'apps/web/app/(shell)/help/page.tsx'],
      ['/caregiver', 'apps/web/app/(shell)/caregiver/page.tsx'],
      ['/admin', 'apps/web/app/(shell)/admin/page.tsx'],
    ]);
    expect(new Map(manifest.routes.map(route => [route.path, route.source]))).toEqual(integratedRoutes);
    expect(manifest.baseUrls).toEqual({
      web: 'http://localhost:3100', mailpit: 'http://localhost:8125', adminer: 'http://localhost:8180',
    });
    for (const route of manifest.routes) {
      expect(route.path).toMatch(/^\//u);
      expect(existsSync(resolve(root, route.source)), `${route.path} -> ${route.source}`).toBe(true);
    }
    expect(manifest.accounts).toEqual(demoAccounts.map(account => ({
      role: account.role, name: account.name, userId: account.userId, code: account.code,
    })));
    expect(read('docs/reviewer-access.md')).not.toMatch(/localhost:3000|ss-lane\d/u);
    assertHumanAccess(read('docs/reviewer-access.md'));
    assertHumanRoutes(read('docs/demo/storyboard.md'));
    expect(manifest.fixtureVersion).toBe(DEMO_FIXTURE_VERSION);
    expect(read('packages/db/migrations/0180_wp-034_demo.sql')).toContain(`'${manifest.expiry.accountCodeExpiresAt}'::timestamptz`);
    expect(manifest.expiry.sessionLifetimeHours).toBe(12);
    expect(read('packages/auth/src/service.ts')).toContain('isDemo ? 12 * 60 * MINUTE');
    const packet = read('docs/reviewer-access.md');
    expect(packet).toContain(manifest.expiry.accountCodeExpiresAt);
    expect(packet).toContain(`**${manifest.expiry.sessionLifetimeHours}-hour**`);
    expect(packet).toContain('**single-use**');
    expect(manifest.expiry.codeUse).toBe('single-use until the next successful demo reset');
  });

  it('rejects stale codes and routes in the human access table, not only the manifest', () => {
    const packet = read('docs/reviewer-access.md');
    expect(() => assertHumanAccess(packet.replace('`DEMO-SENIOR`', '`DEMO-STALE`'))).toThrow();
    expect(() => assertHumanAccess(packet.replace('`/caregiver`', '`/missing-caregiver`'))).toThrow();
    expect(() => assertHumanAccess(packet.replace('http://localhost:3100/auth/demo-code', 'http://localhost:3100/auth/obsolete'))).toThrow();
  });

  it('maps every assigned scored criterion inside a sub-twelve-minute plan', () => {
    // what_bug_this_catches: a polished tour omits a scored row or quietly grows beyond the bid limit.
    const required = ['A-8', 'F-1', 'F-2', 'F-7', 'F-8', 'F-11', 'F-13', 'SC-07'];
    expect(manifest.criteria.map(item => item.id).sort()).toEqual(required.sort());
    expect(manifest.criteria.every(item => item.source.includes(':'))).toBe(true);
    const mapped = new Set(manifest.segments.flatMap(segment => segment.criteria));
    for (const criterion of required) expect(mapped.has(criterion), criterion).toBe(true);
    const sum = manifest.segments.reduce((total, segment) => total + segment.seconds, 0);
    expect(sum).toBe(manifest.plannedSeconds);
    expect(sum).toBeLessThan(12 * 60);
    expect(manifest.maximumSeconds).toBeLessThan(12 * 60);
    expect(sum).toBeLessThanOrEqual(manifest.maximumSeconds);
    const shots = [...read('docs/demo/storyboard.md').matchAll(/^\| (\d{2}):(\d{2})–(\d{2}):(\d{2}) \|.*$/gmu)];
    expect(shots).toHaveLength(manifest.segments.length);
    let previousEnd = 0;
    for (const [index, shot] of shots.entries()) {
      const start = Number(shot[1]) * 60 + Number(shot[2]);
      const end = Number(shot[3]) * 60 + Number(shot[4]);
      expect(start).toBe(previousEnd);
      expect(end - start).toBe(manifest.segments[index]?.seconds);
      expect([...(shot[0].match(/\b(?:F-\d+|A-\d+|SC-\d+)\b/gu) ?? [])].sort())
        .toEqual([...(manifest.segments[index]?.criteria ?? [])].sort());
      previousEnd = end;
    }
    expect(previousEnd).toBe(manifest.plannedSeconds);
  });

  it('publishes complete private-local evidence with the rehearsed ss-n0 startup', () => {
    expect(manifest.runnable).toBe(true);
    expect(manifest.readinessBlockers).toEqual([]);
    expect(manifest.webStart).toEqual({
      command: 'pnpm demo:up', bindAddress: '127.0.0.1', port: 3100,
      healthPath: '/api/v1/health', healthStatus: 'ok', detached: true,
      downCommand: 'pnpm demo:down', coldRehearsed: true,
    });
    const docs = ownedDocs.map(path => read(path)).join('\n');
    expect(docs).not.toContain('ss-n0-web-start');
    expect(docs).toContain('loopback');
    expect(docs).toContain('WP-030');
    for (const blocker of manifest.readinessBlockers) expect(blocker.reason.length).toBeGreaterThan(40);
    for (const path of ownedDocs.filter(path => path.endsWith('.md'))) {
      const document = read(path);
      assertCompletePrivateLocal(document);
      expect(() => assertCompletePrivateLocal(document.replace('Runnable: true', 'Runnable: false'))).toThrow();
      expect(() => assertCompletePrivateLocal(`${document}\nNo recording yet.`)).toThrow();
    }
  });

  it('publishes the rehearsed AI-off state without claiming a model result', () => {
    // what_bug_this_catches: packet prose removing the blocker while omitting the effective kill switches or inventing provider evidence.
    expect(manifest.aiOffFixture).toEqual({
      orgFlags: { 'ai.master': false, 'ai.concierge': false },
      effective: { 'ai.master': false, 'ai.concierge': false },
      aiEventCount: 0,
      nativePages: ['/concierge', '/services', '/help'],
    });
    const docs = ownedDocs.map(path => read(path)).join('\n');
    expect(docs).not.toContain('ss-n0-ai-off');
    expect(docs).toContain('zero AI events');
    expect(docs).toContain('no model-call, provider-result, or spending claim');
  });

  it('publishes the rehearsed fixture IDs without claiming caregiver authority', () => {
    // what_bug_this_catches: reviewer instructions drifting from seeded IDs or silently pre-granting caregiver access.
    expect(manifest.journeyFixtures).toEqual({
      caregiverLinkId: '41000000-0000-4000-8100-000000000001',
      caregiverState: 'pending',
      preGrantedScopeCount: 0,
      readBackCount: 0,
      fullEventId: '41000000-0000-4000-8200-000000000001',
      capacity: 1,
      attendingCount: 1,
      waitlistedCount: 1,
    });
    const packet = read('docs/reviewer-access.md');
    expect(packet).toContain(manifest.journeyFixtures.caregiverLinkId);
    expect(packet).toContain(manifest.journeyFixtures.fullEventId);
    expect(packet).toContain('zero pre-granted scopes and zero read-backs');
    expect(read('docs/demo/storyboard.md')).not.toContain('ss-n0-journey-fixtures');
  });

  it('records the exact accepted take without weakening private-local boundaries', () => {
    // what_bug_this_catches: packet prose retains stale pending status or treats a diagnostic capture as accepted evidence.
    const storyboard = read('docs/demo/storyboard.md');
    const packet = read('docs/reviewer-access.md');
    const limitations = read('docs/demo/known-limitations.md');
    expect(manifest.knownLimitations).toBe('docs/demo/known-limitations.md');
    expect(existsSync(resolve(root, manifest.knownLimitations))).toBe(true);
    expect(storyboard).toContain('(./known-limitations.md)');
    expect(packet).toContain('(./demo/known-limitations.md)');
    expect(manifest.recordingStatus).toBe('complete-private-local');
    expect(manifest.recordingGate).toContain(manifest.captureEvidence.sealedApplicationSha);
    expect(manifest.recordingGate).toContain(manifest.captureEvidence.integratedReceiptCommit);
    expect(storyboard).toContain('38/38 passed in 4.5 minutes, with zero failures or skips');
    expect(packet).toContain('38/38 in 4.5 minutes with zero failures or skips');
    expect(limitations).toContain('passed 38/38 in 8.4 minutes with zero failures or skips');
    for (const document of [storyboard, packet, limitations]) {
      expect(document).not.toMatch(/hardening and red|red on state-transfer seams|Spanish consumers.*(?:red|pending)/iu);
      expect(document).toContain('sealed');
      assertCompletePrivateLocal(document);
      expect(document).toMatch(/all R1 and R2 attempts are excluded/iu);
      expect(document).toContain('Could not load this section');
      expect(document).toMatch(/outside the scored set/iu);
      expect(document).toMatch(/not evidence of translation-review completion/iu);
      for (const diagnostic of manifest.captureEvidence.excludedDiagnostics) {
        if (diagnostic.startsWith('WP-041')) expect(document).toContain(diagnostic);
      }
    }
    for (const document of [storyboard, packet]) {
      expect(document).toMatch(/one native Playwright context and page with no splice, transcode, or re-encode/iu);
    }
    for (const name of [
      'Grounded service help completes',
      'RSVP and capacity waitlist complete',
      'Resident ride request reaches authoritative staff state',
      'Resident priority request enters staff handling',
      'Itemized consent revokes immediately',
      'AI-off native completion remains usable',
    ]) expect(storyboard).toContain(name);
    const wp030 = read('agentops/build/board.csv').split(/\r?\n/u).find(line => line.startsWith('"WP-030"')) ?? '';
    const wp032 = read('agentops/build/board.csv').split(/\r?\n/u).find(line => line.startsWith('"WP-032"')) ?? '';
    expect(wp030).toMatch(/^"WP-030","[^"]+","built",/u);
    expect(wp032).toMatch(/^"WP-032","[^"]+","built",/u);
    expect(manifest.recordingStatus).toBe('complete-private-local');
  });

  it('makes the satisfied exact-candidate gate executable and auditable', () => {
    // what_bug_this_catches: completion points at an unsealed revision or lacks repeatable gate, checksum, and teardown evidence.
    expect(manifest.credentialedCloseout).toEqual({
      status: 'passed',
      command: 'corepack pnpm exec playwright test --config tests/e2e/es/credentialed.playwright.config.ts',
      passed: 38, failed: 0, skipped: 0, duration: '4.5m',
      composition: {
        credentialedFullPass: 8, crossModuleActions: 24, controlledApprovals: 6,
        spanishStandardEasyActions: 12, shippedPagesChecked: 21,
      },
      scope: 'WP-030 and WP-032 credentialed EN/ES Standard/Easy journeys, controlled approvals, and role-bound governed-copy coverage',
      provenanceCommit: '6ed23f1', adoptedCommit: 'c78d13c', integrationCommit: '71ab2b1',
    });
    expect(manifest.captureGate.status).toBe('passed');
    expect(manifest.captureGate.blockedBy).toBeNull();
    expect(manifest.captureGate.commands).toEqual([
      'git status --short',
      'git rev-parse HEAD',
      manifest.credentialedCloseout.command,
      'pnpm demo:down',
      'pnpm demo:reset',
      'pnpm demo:up',
      'curl.exe -fsS http://127.0.0.1:3100/api/v1/health',
      'pnpm demo:down',
    ]);
    expect(manifest.captureGate.requiredCredentialedEnvironment).toHaveLength(4);
    expect(manifest.captureGate.evidenceFields).toEqual(expect.arrayContaining([
      'sealedApplicationSha', 'integratedReceiptCommit', 'credentialedPassed', 'credentialedFailed',
      'credentialedSkipped', 'wallClockSeconds', 'mediaContainerSeconds', 'mediaFile', 'mediaSha256',
      'teardownStatus', 'excludedDiagnostics',
    ]));
    expect(manifest.captureGate.evidenceFields.sort())
      .toEqual(Object.keys(manifest.captureEvidence).sort());
    expect(manifest.captureGate.stopConditions.length).toBeGreaterThanOrEqual(7);
    expect(manifest.captureEvidence).toEqual({
      scope: 'complete private-local evidence only',
      sealedApplicationSha: 'c379d2b69a162d8fab46409bdb5ed9af1373b3da',
      integratedReceiptCommit: '8863b94',
      receiptPath: 'docs/evidence/WP-041-sealed-recording-c379d2b.md',
      credentialedCommand: manifest.credentialedCloseout.command,
      credentialedPassed: 38, credentialedFailed: 0, credentialedSkipped: 0,
      credentialedDuration: '8.4m', fixtureVersion: 'wp-034.v1+ss-n0.v1',
      staffQueueHttpStatus: 200, adminQueueHttpStatus: 200,
      recordingStartedAt: '2026-09-12T03:20:09.344Z',
      recordingEndedAt: '2026-09-12T03:21:55.508Z',
      wallClockSeconds: 106.164, mediaContainerSeconds: 109.120,
      mediaFile: 'WP-041-sealed-tour-c379d2b-r3-realtime2.webm',
      mediaSha256: '1A46195319956BE71F6B6CBE7589D7F7B7361753DE2147AC11429E4A2410BF26',
      capturedBy: '0209_Codex_GPT56-SOL',
      teardownStatus: 'zero ss-n0 containers, volumes, networks, generated state, and temporary auth state',
      excludedDiagnostics: [
        'all R1 and R2 attempts',
        'WP-041-sealed-tour-c379d2b-r3.webm',
        'WP-041-sealed-tour-c379d2b-r3-realtime-incomplete1.webm',
      ],
    });
    expect(existsSync(resolve(root, manifest.captureEvidence.receiptPath))).toBe(true);
    expect(manifest.captureEvidence.mediaSha256).toMatch(/^[A-F0-9]{64}$/u);
    const packet = read('docs/reviewer-access.md');
    for (const command of manifest.captureGate.commands.slice(0, -1)) expect(packet).toContain(command);
    for (const field of manifest.captureGate.evidenceFields) {
      expect(field.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('contains no private credential patterns in reviewer-facing artifacts', () => {
    // what_bug_this_catches: copying cold-start commands leaks a database URL, pepper, key, or private path.
    const privatePattern = /(?:\.creds[\\/]|postgres(?:ql)?:\/\/|AUTH_TOKEN_PEPPER\s*=|DATABASE_URL\s*=|(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/iu;
    for (const path of ownedDocs) expect(read(path), path).not.toMatch(privatePattern);
  });
});
