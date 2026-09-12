import { publicServiceContext } from './_context';
import { serviceError, ServiceInputError, noStoreJson } from './_response';
import { servicesRepository } from './_runtime';
import type { ServicesRepository } from '@seniorsocial/services';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const filter = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createSearchServicesHandler(repository: () => ServicesRepository = servicesRepository) {
  return async (request: Request): Promise<Response> => {
  try {
    const context = publicServiceContext();
    const query = new URL(request.url).searchParams;
    const localeValue = query.get('locale') ?? 'en';
    if (localeValue !== 'en' && localeValue !== 'es') throw new ServiceInputError('locale must be en or es');
    const text = query.get('q')?.trim();
    if (text && text.length > 500) throw new ServiceInputError('q must be at most 500 characters');
    const categoryId = query.get('category') ?? undefined;
    if (categoryId && !uuid.test(categoryId)) throw new ServiceInputError('category must be a UUID');
    const language = query.get('language') ?? undefined;
    const accessibility = query.get('accessibility') ?? undefined;
    if (language && !filter.test(language)) throw new ServiceInputError('language is invalid');
    if (accessibility && !filter.test(accessibility)) throw new ServiceInputError('accessibility is invalid');
    const cursor = query.get('cursor') ?? undefined;
    if (cursor && !/^\d+$/u.test(cursor)) throw new ServiceInputError('cursor is invalid');
    const cursorValue = cursor === undefined ? undefined : Number(cursor);
    if (cursorValue !== undefined && (!Number.isSafeInteger(cursorValue) || cursorValue < 0 || cursorValue > 10_000)) {
      throw new ServiceInputError('cursor is outside the supported range');
    }
    const limitValue = query.get('limit');
    const limit = limitValue === null ? undefined : Number(limitValue);
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)) {
      throw new ServiceInputError('limit must be an integer from 1 to 100');
    }
    const result = await repository().search(context.orgId, {
      locale: localeValue,
      ...(text === undefined ? {} : { query: text }),
      ...(categoryId === undefined ? {} : { categoryId }),
      ...(language === undefined ? {} : { language }),
      ...(accessibility === undefined ? {} : { accessibility }),
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
    return noStoreJson({ items: result.items, meta: { next_cursor: result.nextCursor } });
  } catch (error) {
    return serviceError(error);
  }
  };
}

export const GET = createSearchServicesHandler();
