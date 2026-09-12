import { withAssistanceRuntime } from './_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => withAssistanceRuntime(request, handlers => handlers.GET(request));
export const POST = (request: Request) => withAssistanceRuntime(request, handlers => handlers.POST(request));
