import { publicServiceContext } from '../_context';
import { serviceError, ServiceInputError, noStoreJson } from '../_response';
import { servicesRepository } from '../_runtime';
import type { ServicesRepository } from '@seniorsocial/services';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createGetServiceHandler(repository: () => ServicesRepository = servicesRepository) {
  return async (request: Request, route: { params: Promise<{ serviceId: string }> }): Promise<Response> => {
  try {
    const context = publicServiceContext();
    const { serviceId } = await route.params;
    if (!uuid.test(serviceId)) throw new ServiceInputError('serviceId must be a UUID');
    const localeValue = new URL(request.url).searchParams.get('locale') ?? 'en';
    if (localeValue !== 'en' && localeValue !== 'es') throw new ServiceInputError('locale must be en or es');
    const service = await repository().get(context.orgId, serviceId, localeValue);
    return service ? noStoreJson(service) : noStoreJson({ type: 'about:blank', title: 'Not found', status: 404 }, 404);
  } catch (error) {
    return serviceError(error);
  }
  };
}

export const GET = createGetServiceHandler();
