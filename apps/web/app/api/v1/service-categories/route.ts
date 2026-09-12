import { publicServiceContext } from '../services/_context';
import { serviceError, noStoreJson } from '../services/_response';
import { servicesRepository } from '../services/_runtime';
import type { ServicesRepository } from '@seniorsocial/services';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createListCategoriesHandler(repository: () => ServicesRepository = servicesRepository) {
  return async (): Promise<Response> => {
  try {
    const context = publicServiceContext();
    return noStoreJson({ items: await repository().listCategories(context.orgId) });
  } catch (error) {
    return serviceError(error);
  }
  };
}

export const GET = createListCategoriesHandler();
