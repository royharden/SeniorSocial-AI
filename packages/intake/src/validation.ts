import { intakeIntents, intakeKinds, intakeLocales, type IntakeAnswer, type IntakeAnswers, type IntakeInput, type IntakeKind } from './types.ts';

const answerKey = /^[a-z][a-z0-9_]{0,63}$/u;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export class IntakeError extends Error { constructor(message: string, readonly status = 422) { super(message); } }

export function parseKind(value: string): IntakeKind {
  if (!intakeKinds.includes(value as IntakeKind)) throw new IntakeError('Invalid intake kind', 404);
  return value as IntakeKind;
}

function answer(value: unknown): IntakeAnswer {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 4_000) return value;
  if (Array.isArray(value) && value.length <= 20 && value.every(item => typeof item === 'string' && item.length <= 400)) {
    return value.map(item => String(item));
  }
  throw new IntakeError('Invalid intake answers');
}

export function parseAnswers(value: unknown): IntakeAnswers {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IntakeError('Invalid intake answers');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 32) throw new IntakeError('Too many intake answers');
  const answers: IntakeAnswers = Object.create(null) as IntakeAnswers;
  for (const [key, raw] of entries) {
    if (!answerKey.test(key) || forbiddenKeys.has(key)) throw new IntakeError('Invalid intake answer name');
    answers[key] = answer(raw);
  }
  if (JSON.stringify(answers).length > 16_000) throw new IntakeError('Intake answers are too large');
  return answers;
}

export function parseInput(value: unknown): IntakeInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new IntakeError('Invalid intake request');
  const row = value as Record<string, unknown>;
  const intent = row.intent === undefined ? 'submit' : row.intent;
  if (typeof row.disclaimerAcknowledged !== 'boolean' || typeof row.locale !== 'string' ||
      !intakeLocales.includes(row.locale as IntakeInput['locale']) ||
      typeof intent !== 'string' || !intakeIntents.includes(intent as IntakeInput['intent']) ||
      typeof row.answers !== 'object' || row.answers === null || Array.isArray(row.answers)) {
    throw new IntakeError('Invalid intake request');
  }
  const answers = parseAnswers(row.answers);
  if (intent === 'submit' && !row.disclaimerAcknowledged) {
    throw new IntakeError('Disclaimer acknowledgment is required before submission');
  }
  return { answers, disclaimerAcknowledged: row.disclaimerAcknowledged,
    locale: row.locale as IntakeInput['locale'], intent: intent as IntakeInput['intent'] };
}

export function requireIdempotencyKey(value: string): string {
  const key = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,160}$/u.test(key)) throw new IntakeError('Idempotency-Key is required', 409);
  return key;
}
