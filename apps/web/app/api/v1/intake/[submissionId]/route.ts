import { body, failure, patchInput, present, problem, validSubmissionId, type IntakeHttpDependencies } from '../_http';
import { runtimeDependencies } from '../_runtime';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';

export function createIntakeSubmissionHandlers(dependencies: IntakeHttpDependencies) {
  return {
    GET: async (request: Request, context: { params: Promise<{ submissionId: string }> }): Promise<Response> => {
      const actor = await dependencies.authorize(request); if (!actor) return problem(404, 'Not found');
      const id = (await context.params).submissionId; if (!validSubmissionId(id)) return problem(404, 'Not found');
      try { return Response.json(present(await dependencies.intake.get(actor, id)),
        { headers: { 'cache-control': 'no-store' } }); } catch (error) { return failure(error); }
    },
    PATCH: async (request: Request, context: { params: Promise<{ submissionId: string }> }): Promise<Response> => {
      const actor = await dependencies.authorize(request); if (!actor) return problem(404, 'Not found');
      const value = await body(request); if (!value) return problem(422, 'Invalid intake request');
      try {
        const id = (await context.params).submissionId; if (!validSubmissionId(id)) return problem(404, 'Not found');
        const before = await dependencies.intake.get(actor, id);
        const submission = await dependencies.intake.save(actor, before.kind, patchInput(value, before),
          request.headers.get('idempotency-key') ?? '', id);
        return Response.json(present(submission), { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return failure(error); }
    },
  };
}
const handlers = createIntakeSubmissionHandlers(runtimeDependencies);
export const GET = handlers.GET; export const PATCH = handlers.PATCH;
