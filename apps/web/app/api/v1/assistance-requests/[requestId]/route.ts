import { withAssistanceRuntime } from '../_runtime';

export const GET = async (request: Request, context: { params: Promise<{ requestId: string }> }) => {
  const { requestId } = await context.params;
  return withAssistanceRuntime(request, handlers => handlers.GET_ONE(request, requestId));
};
