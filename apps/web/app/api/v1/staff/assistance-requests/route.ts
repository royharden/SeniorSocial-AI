import { withAssistanceRuntime } from '../../assistance-requests/_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = (request: Request) =>
  withAssistanceRuntime(request, handlers => handlers.STAFF_QUEUE(request));
