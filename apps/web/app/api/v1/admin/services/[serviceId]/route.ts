import type { AdminServices } from '../_runtime';
import { adminServicesRuntime } from '../_runtime';
import { patchServiceInput, requestLocale } from '../_input';
import { adminServiceContext, requireSameOrigin, type AdminServiceContext } from '../../../services/_context';
import { serviceError, ServiceInputError, noStoreJson } from '../../../services/_response';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createPatchServiceHandler(
  services: () => AdminServices = adminServicesRuntime,
  context: (request: Request) => Promise<AdminServiceContext> = adminServiceContext,
) {
  return async (request: Request, route: { params: Promise<{ serviceId: string }> }): Promise<Response> => {
    try {
      requireSameOrigin(request);
      const actor = await context(request);
      const { serviceId } = await route.params;
      if (!uuid.test(serviceId)) throw new ServiceInputError('serviceId must be a UUID');
      const updated = await services().update(actor, serviceId, await patchServiceInput(request), requestLocale(request));
      return updated ? noStoreJson(updated) : noStoreJson({ type: 'about:blank', title: 'Not found', status: 404 }, 404);
    } catch (error) { return serviceError(error); }
  };
}

export const PATCH = createPatchServiceHandler();
