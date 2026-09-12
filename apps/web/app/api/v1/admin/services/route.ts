import type { AdminServices } from './_runtime';
import { adminServicesRuntime } from './_runtime';
import { createServiceInput, requestLocale } from './_input';
import { adminServiceContext, requireSameOrigin, type AdminServiceContext } from '../../services/_context';
import { serviceError, noStoreJson } from '../../services/_response';

export function createPostServiceHandler(
  services: () => AdminServices = adminServicesRuntime,
  context: (request: Request) => Promise<AdminServiceContext> = adminServiceContext,
) {
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request);
      const actor = await context(request);
      const created = await services().create(actor, await createServiceInput(request), requestLocale(request));
      return noStoreJson(created, 201);
    } catch (error) { return serviceError(error); }
  };
}

export const POST = createPostServiceHandler();
