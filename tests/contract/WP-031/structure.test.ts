import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { routes as automatedRoutes } from '../../a11y/WP-031/route-matrix.ts';
import { validateHumanMatrixBinding, type HumanMatrixBinding } from './binding.ts';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFile(join(root, path), 'utf8');

interface Action {
  readonly id: string;
  readonly routeId: string;
  readonly control: { readonly role: string; readonly name: { readonly en: string; readonly es: string } };
  readonly operation: string;
  readonly expected: { readonly state: string; readonly announcement: string };
}

interface Step {
  readonly id: string;
  readonly actionId?: string;
  readonly operation?: string;
  readonly expectations: readonly string[];
}

interface Matrix {
  readonly schemaVersion: number;
  readonly status: string;
  readonly binding: HumanMatrixBinding;
  readonly resultVocabulary: readonly string[];
  readonly resultRules: Record<string, string>;
  readonly platforms: readonly {
    readonly id: string; readonly assistiveTechnology: string; readonly browser: string;
    readonly operatingSystem: string; readonly setup: readonly string[]; readonly keys: Record<string, string>;
  }[];
  readonly locales: readonly string[];
  readonly modes: readonly string[];
  readonly coverageRuns: readonly {
    readonly id: string; readonly platformId: string; readonly locale: string; readonly mode: string;
    readonly result: string; readonly tester: null; readonly startedAtUtc: null; readonly completedAtUtc: null;
    readonly evidenceRecord: null; readonly defectIds: readonly string[];
  }[];
  readonly routes: readonly { readonly id: string; readonly path: string; readonly name: string; readonly actionIds: readonly string[] }[];
  readonly actions: readonly Action[];
  readonly journeys: readonly { readonly id: string; readonly name: string; readonly actionIds?: readonly string[]; readonly steps: readonly Step[] }[];
  readonly evidenceRequirements: {
    readonly run: readonly string[]; readonly step: readonly string[]; readonly defect: readonly string[];
    readonly severityVocabulary: readonly string[]; readonly media: string; readonly privacy: string;
  };
  readonly humanExecutionClaim: string;
}

async function matrix(): Promise<Matrix> {
  return JSON.parse(await read('tests/a11y/WP-031/human-screen-reader-matrix.json')) as Matrix;
}

describe('WP-031 human screen-reader matrix structure', () => {
  test('commits an explicitly unrun template with the exact sealed binding and result semantics', async () => {
    const value = await matrix();
    expect(value.schemaVersion).toBe(1);
    expect(value.status).toBe('template_not_run');
    expect(value.humanExecutionClaim).toBe('not_run');
    expect(value.binding.sealedCandidateSha).toBe('c379d2b69a162d8fab46409bdb5ed9af1373b3da');
    expect(value.binding.localBaseUrl).toBe('http://127.0.0.1:3100');
    expect(value.resultVocabulary).toEqual(['not_run', 'pass', 'fail', 'blocker']);
    expect(value.resultRules.sightedAssistance).toBe('blocker');
    expect(value.resultRules.blocker).toMatch(/sighted assistance/i);
  });

  test('covers the exact platform by language by mode product with environment capture', async () => {
    const value = await matrix();
    expect(value.platforms.map(platform => platform.id).sort()).toEqual([
      'nvda-chrome-windows', 'voiceover-safari-macos',
    ]);
    expect(value.platforms.map(platform => [platform.assistiveTechnology, platform.browser, platform.operatingSystem])).toEqual([
      ['NVDA', 'Google Chrome', 'Windows'], ['VoiceOver', 'Safari', 'macOS'],
    ]);
    expect(value.platforms.find(platform => platform.id === 'voiceover-safari-macos')?.keys.top)
      .toMatch(/^Control\+Option\+Home/);
    expect(value.platforms.find(platform => platform.id === 'voiceover-safari-macos')?.keys.top)
      .not.toMatch(/Shift\+Home/);
    for (const platform of value.platforms) {
      expect(platform.setup.length, platform.id).toBeGreaterThanOrEqual(4);
      expect(Object.values(platform.keys).join(' '), platform.id).toMatch(/Tab/);
      expect(Object.values(platform.keys).join(' '), platform.id).toMatch(/Home/);
    }
    expect(value.locales).toEqual(['en', 'es']);
    expect(value.modes).toEqual(['standard', 'easy']);
    const expected = value.platforms.flatMap(platform => value.locales.flatMap(locale =>
      value.modes.map(mode => `${platform.id}:${locale}:${mode}`))).sort();
    const actual = value.coverageRuns.map(run => `${run.platformId}:${run.locale}:${run.mode}`).sort();
    expect(actual).toEqual(expected);
    expect(new Set(value.coverageRuns.map(run => run.id)).size).toBe(8);
    for (const run of value.coverageRuns) {
      expect(run).toMatchObject({ result: 'not_run', tester: null, startedAtUtc: null, completedAtUtc: null, evidenceRecord: null, defectIds: [] });
    }
  });

  test('matches all integrated routes and makes every route action resolvable', async () => {
    const value = await matrix();
    expect(value.routes.map(route => ({ path: route.path, name: route.name })))
      .toEqual(automatedRoutes.map(route => ({ path: route.path, name: route.name })));
    const actionIds = value.actions.map(action => action.id);
    expect(new Set(actionIds).size).toBe(actionIds.length);
    const routeIds = new Set(value.routes.map(route => route.id));
    for (const route of value.routes) {
      expect(route.actionIds.length, route.path).toBeGreaterThan(0);
      for (const actionId of route.actionIds) expect(actionIds, `${route.path}:${actionId}`).toContain(actionId);
    }
    for (const action of value.actions) {
      expect(routeIds, action.id).toContain(action.routeId);
      expect(action.control.role, action.id).not.toBe('');
      expect(action.control.name.en, action.id).not.toBe('');
      expect(action.control.name.es, action.id).not.toBe('');
      expect(action.operation, action.id).not.toBe('');
      expect(action.expected.state, action.id).not.toBe('');
      expect(action.expected.announcement, action.id).not.toBe('');
    }
  });

  test('records current English-fallback control names for the unreviewed Spanish candidate', async () => {
    const value = await matrix();
    const currentFallbackActions = [
      'ACTION-STATIC-LANDING', 'ACTION-HOME-SERVICES', 'ACTION-HOME-EVENTS',
      'ACTION-MODE-EASY', 'ACTION-MODE-STANDARD', 'ACTION-NOTIFY-LOAD', 'ACTION-NOTIFY-SAVE',
      'ACTION-EVENTS-LOAD', 'ACTION-EVENT-RSVP', 'ACTION-EVENT-WAITLIST', 'ACTION-EVENT-CANCEL',
      'ACTION-EVENT-SUGGEST', 'ACTION-CAREGIVER-INVITE', 'ACTION-CAREGIVER-SAVE',
      'ACTION-CAREGIVER-REVOKE', 'ACTION-RIDE-INVALID', 'ACTION-RIDE-SUBMIT',
      'ACTION-DISPLAY-CONFIRM', 'ACTION-PRINT-LOAD', 'ACTION-PRINT-AUTHORIZED',
      'ACTION-SERVICE-SEARCH', 'ACTION-CONCIERGE-START', 'ACTION-CONCIERGE-SEARCH',
      'ACTION-CONCIERGE-HANDOFF',
    ];
    for (const actionId of currentFallbackActions) {
      const action = value.actions.find(candidate => candidate.id === actionId);
      expect(action?.control.name.es, actionId).toBe(action?.control.name.en);
    }
  });

  test('has stable journey and step identity plus complete status expectations', async () => {
    const value = await matrix();
    const actionIds = new Set(value.actions.map(action => action.id));
    const journeyIds = value.journeys.map(journey => journey.id);
    expect(new Set(journeyIds).size).toBe(journeyIds.length);
    expect(journeyIds).toEqual(expect.arrayContaining([
      'JOURNEY-ALL-ROUTES', 'JOURNEY-HOME-SERVICE-SEARCH', 'JOURNEY-RIDE-ERROR-READBACK',
      'JOURNEY-MODE-LANGUAGE', 'JOURNEY-STATUS-ACTIONS',
    ]));
    const stepIds = value.journeys.flatMap(journey => journey.steps.map(step => step.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
    for (const journey of value.journeys) {
      expect(journey.name).not.toBe('');
      expect(journey.steps.length, journey.id).toBeGreaterThan(0);
      for (const actionId of journey.actionIds ?? []) expect(actionIds, `${journey.id}:${actionId}`).toContain(actionId);
      for (const step of journey.steps) {
        expect(step.expectations.length, step.id).toBeGreaterThan(0);
        if (step.actionId !== undefined) expect(actionIds, step.id).toContain(step.actionId);
        else expect(step.operation, step.id).not.toBe('');
      }
    }
    const statusJourney = value.journeys.find(journey => journey.id === 'JOURNEY-STATUS-ACTIONS');
    expect(statusJourney?.actionIds).toHaveLength(19);
    expect(statusJourney?.actionIds).toEqual(expect.arrayContaining([
      'ACTION-NOTIFY-SAVE', 'ACTION-HELP-SUBMIT', 'ACTION-EVENT-RSVP', 'ACTION-CAREGIVER-SAVE',
      'ACTION-RIDE-SUBMIT', 'ACTION-PRINT-LOAD', 'ACTION-SERVICE-SEARCH', 'ACTION-CONCIERGE-HANDOFF',
    ]));
  });

  test('requires reproducible run, transcript, defect, severity, and media evidence', async () => {
    const value = await matrix();
    expect(value.evidenceRequirements.run).toEqual(expect.arrayContaining([
      'sealedCandidateSha', 'localBaseUrl', 'tester', 'startedAtUtc', 'completedAtUtc',
      'candidateState', 'boundBy', 'boundAtUtc', 'operatingSystemVersion', 'browserVersion',
      'assistiveTechnologyVersion', 'locale', 'mode', 'result',
    ]));
    expect(value.evidenceRequirements.step).toEqual(expect.arrayContaining([
      'journeyId', 'stepId', 'route', 'actionId', 'result', 'exactKeystrokes', 'verbatimTranscript',
      'observedName', 'observedRole', 'observedStates', 'observedLiveAnnouncement', 'timestampUtc', 'evidenceFiles', 'defectId',
    ]));
    expect(value.evidenceRequirements.defect).toEqual(expect.arrayContaining([
      'defectId', 'severity', 'successCriterion', 'reproductionKeystrokes', 'expected', 'actualTranscript',
      'evidenceFiles', 'disposition', 'ownerAndTarget', 'rerunLinkage',
    ]));
    expect(value.evidenceRequirements.severityVocabulary).toEqual(['critical', 'high', 'medium', 'low']);
    expect(value.evidenceRequirements.media).toMatch(/never replaces.*transcript/i);
    expect(value.evidenceRequirements.privacy).toMatch(/credentials.*real names.*phone numbers/i);
  });

  test('binding validator rejects placeholders, malformed/unsealed values, and accepts a sealed local example', async () => {
    const value = await matrix();
    expect(validateHumanMatrixBinding(value.binding)).toEqual([]);
    const base = { ...value.binding, priorAutomatedBaselinesAreNotThisCandidate: value.binding.priorAutomatedBaselinesAreNotThisCandidate };
    expect(validateHumanMatrixBinding({ ...base, sealedCandidateSha: 'ABC', localBaseUrl: 'https://example.com/app', candidateState: 'built', boundBy: '', boundAtUtc: 'today' }).length)
      .toBeGreaterThanOrEqual(6);
    expect(validateHumanMatrixBinding({
      ...base,
      sealedCandidateSha: '1234567890abcdef1234567890abcdef12345678',
      localBaseUrl: 'http://localhost:3132',
      candidateState: 'post_repair_sealed',
      boundBy: '0184_Codex_GPT56-SOL_Integrator',
      boundAtUtc: '2026-09-12T01:02:03Z',
    })).toEqual([]);
    expect(validateHumanMatrixBinding({
      ...base,
      sealedCandidateSha: '23f8cfdc597d9ccbf41d0b8512c6b3e58194281c',
      localBaseUrl: 'http://127.0.0.1:3132',
      candidateState: 'post_repair_sealed',
      boundBy: '0184_Codex_GPT56-SOL_Integrator',
      boundAtUtc: '2026-09-12T01:02:03Z',
    })).toContain('sealedCandidateSha must be distinct from recorded automated baselines');
  });

  test('protocol, template, and both audit documents link truthfully', async () => {
    const [protocol, template, closeout, audit] = await Promise.all([
      read('docs/ui/human-screen-reader-protocol.md'), read('docs/ui/human-screen-reader-evidence-template.md'),
      read('docs/ui/accessibility.md'), read('docs/ui/accessibility-audit.md'),
    ]);
    for (const text of [protocol, closeout, audit]) {
      expect(text).toContain('human-screen-reader-matrix.json');
      expect(text).toMatch(/not run|unrun|not_run/i);
      expect(text).not.toMatch(/human (?:screen-reader )?(?:testing|validation) (?:passed|complete)/i);
    }
    expect(protocol).toMatch(/VoiceOver \+ Safari on macOS/i);
    expect(protocol).toMatch(/retained §9\.2.*iOS/i);
    expect(protocol).toMatch(/sighted assistance.*blocker/i);
    expect(protocol).toMatch(/not certification.*VPAT.*user study/i);
    expect(protocol).toMatch(/cannot prove Git ancestry or chronology from SHA text/i);
    for (const required of ['Exact keystrokes', 'Verbatim AT transcript', 'Severity', 'Success criterion', 'Evidence files']) {
      expect(template).toContain(required);
    }
    expect(template).toContain('c379d2b69a162d8fab46409bdb5ed9af1373b3da');
    expect(template).toContain('http://127.0.0.1:3100');
    expect(audit).toMatch(/all eight.*remain `not_run`/i);
    expect(audit).toMatch(/not a completed accessibility gate or certification/i);
  });
});
