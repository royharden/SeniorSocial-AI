import type { CaregiverService, SessionIdentity } from '../../../../../../packages/caregiver/src/index';
import { CaregiverProblem } from '../../../../../../packages/caregiver/src/index';

export interface CaregiverRouteDependencies {
  /** WP-004 session resolver. It derives org/user/roles and verified recipient server-side. */
  authorize(request: Request): Promise<SessionIdentity | null>;
  service: CaregiverService;
}

export function problem(status: number, code: string): Response {
  const title = status === 400 ? 'Bad Request' : status === 410 ? 'Gone' : status === 503 ? 'Service Unavailable' : 'Not Found';
  return Response.json({ type: 'about:blank', title, status, detail: code }, { status,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' } });
}

export async function identity(dependencies: CaregiverRouteDependencies, request: Request): Promise<SessionIdentity | Response> {
  const value = await dependencies.authorize(request);
  return value ?? problem(404, 'not_found');
}

export async function json(request: Request): Promise<unknown> {
  try { return await request.json(); } catch { throw new CaregiverProblem(400, 'invalid_request'); }
}

export async function run(work: () => Promise<Response>): Promise<Response> {
  try { return await work(); }
  catch (error) {
    if (error instanceof CaregiverProblem) return problem(error.status, error.code);
    return problem(503, 'caregiver_unavailable');
  }
}
