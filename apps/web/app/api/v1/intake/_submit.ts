import type { IntakeKind } from '@seniorsocial/intake';
import { body, failure, input, present, problem, type IntakeHttpDependencies } from './_http';

export function createSubmitIntakeHandler(kind: IntakeKind, dependencies: IntakeHttpDependencies) {
  return async (request: Request): Promise<Response> => {
    const actor = await dependencies.authorize(request); if (!actor) return problem(404, 'Not found');
    const value = await body(request); if (!value) return problem(422, 'Invalid intake request');
    try {
      const submission = await dependencies.intake.save(actor, kind, input(value), request.headers.get('idempotency-key') ?? '');
      return Response.json(present(submission), { status: 201, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return failure(error); }
  };
}
