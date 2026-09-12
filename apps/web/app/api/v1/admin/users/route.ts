import { adminContext, adminResponse, adminRuntime, okay, type AdminService } from './_shared';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
export function createListUsersHandler(service: () => AdminService = adminRuntime, context = adminContext) {
  return async (request: Request) => { try { return okay(await service().listUsers(await context(request))); } catch (error) { return adminResponse(error); } };
}
export const GET = createListUsersHandler();
