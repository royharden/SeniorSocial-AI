import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { validateHumanMatrixBinding, type HumanMatrixBinding } from './binding.ts';

const root = resolve(import.meta.dirname, '../../..');

test('WP-031 human execution is bound to a sealed post-repair local candidate', async () => {
  const raw = await readFile(join(root, 'tests/a11y/WP-031/human-screen-reader-matrix.json'), 'utf8');
  const matrix = JSON.parse(raw) as { readonly binding: HumanMatrixBinding };
  expect(matrix.binding).toMatchObject({
    sealedCandidateSha: 'c379d2b69a162d8fab46409bdb5ed9af1373b3da',
    localBaseUrl: 'http://127.0.0.1:3100',
    candidateState: 'post_repair_sealed',
    boundBy: '0184_Codex_GPT56-SOL_Integrator',
    boundAtUtc: '2026-09-12T03:43:26Z',
  });
  expect(
    validateHumanMatrixBinding(matrix.binding),
    'The human AT template must remain bound to the integrator-attested distinct post-repair sealed candidate.',
  ).toEqual([]);
});

test('WP-031 binding validation continues to fail closed for unsafe or unbound values', async () => {
  const raw = await readFile(join(root, 'tests/a11y/WP-031/human-screen-reader-matrix.json'), 'utf8');
  const matrix = JSON.parse(raw) as { readonly binding: HumanMatrixBinding };

  expect(validateHumanMatrixBinding({
    ...matrix.binding,
    sealedCandidateSha: 'POST_REPAIR_SEALED_SHA',
    localBaseUrl: 'LOCAL_BASE_URL',
    candidateState: 'unbound',
    boundBy: null,
    boundAtUtc: null,
  })).toEqual([
    'sealedCandidateSha still contains POST_REPAIR_SEALED_SHA',
    'localBaseUrl still contains LOCAL_BASE_URL',
    'candidateState must be post_repair_sealed',
    'boundBy must identify the integrator who bound the candidate',
    'boundAtUtc must be a valid second-precision UTC timestamp',
  ]);

  expect(validateHumanMatrixBinding({
    ...matrix.binding,
    sealedCandidateSha: 'ABC',
    localBaseUrl: 'https://example.com/app',
    candidateState: 'built',
    boundBy: '',
    boundAtUtc: 'today',
  }).length).toBeGreaterThanOrEqual(6);

  expect(validateHumanMatrixBinding({
    ...matrix.binding,
    sealedCandidateSha: matrix.binding.priorAutomatedBaselinesAreNotThisCandidate[0] ?? '',
  })).toContain('sealedCandidateSha must be distinct from recorded automated baselines');
});
