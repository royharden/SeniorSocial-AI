import { IntakeError, type Actor, type IntakeService, type IntakeSubmission } from '@seniorsocial/intake';
import type { IntakeSubmission as IntakeSubmissionDto } from '../../../../../../packages/contracts/src/index';

export interface IntakeHttpDependencies { authorize(request: Request): Promise<Actor | null>; intake: IntakeService }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const validSubmissionId = (value: string): boolean => uuid.test(value);

export function problem(status: number, title: string): Response {
  return Response.json({ type: 'about:blank', title, status }, { status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
}
export async function body(request: Request): Promise<Record<string, unknown> | null> {
  try { const value: unknown = await request.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}
function assertTransportKeys(value: Record<string, unknown>): void {
  const allowed = new Set(['answers', 'disclaimer_acknowledged', 'locale', 'intent']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new IntakeError('Invalid intake request');
}
export function input(value: Record<string, unknown>): Record<string, unknown> {
  assertTransportKeys(value);
  return { answers: value.answers, disclaimerAcknowledged: value.disclaimer_acknowledged,
    locale: value.locale ?? 'en', intent: value.intent };
}
export function patchInput(value: Record<string, unknown>, before: IntakeSubmission): Record<string, unknown> {
  assertTransportKeys(value);
  const intent = value.intent ?? 'save_draft';
  return { answers: value.answers ?? before.answers,
    disclaimerAcknowledged: intent === 'submit' ? value.disclaimer_acknowledged :
      (value.disclaimer_acknowledged ?? before.disclaimerAcknowledged),
    locale: value.locale ?? before.locale, intent };
}
export function present(item: IntakeSubmission): IntakeSubmissionDto {
  return { id: item.id, kind: item.kind, state: item.state, answers: item.answers, locale: item.locale,
    disclaimer_acknowledged: item.disclaimerAcknowledged,
    ...(item.routedCategory
      ? { routed_to_partner_category: item.locale === 'es' ? item.routedCategory.labelEs : item.routedCategory.labelEn }
      : {}) };
}
export function failure(error: unknown): Response {
  const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 500;
  const title = status === 404 ? 'Not found' : status === 409 ? 'Conflict' : status === 422 ? 'Invalid intake request' : 'Intake service unavailable';
  return problem(status, title);
}
