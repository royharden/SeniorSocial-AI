import { withAssistanceRuntime } from '../../_runtime';

export const POST = async (request: Request, context: { params: Promise<{ requestId: string }> }) => {
  const { requestId } = await context.params;
  return withAssistanceRuntime(request, handlers => handlers.TRANSITION(request, requestId));
};
