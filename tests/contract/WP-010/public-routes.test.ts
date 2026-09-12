import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServicesRepository } from '../../../packages/services/src/index';
import { createSearchServicesHandler } from '../../../apps/web/app/api/v1/services/route';
import { createGetServiceHandler } from '../../../apps/web/app/api/v1/services/[serviceId]/route';
import { createListCategoriesHandler } from '../../../apps/web/app/api/v1/service-categories/route';

const orgId = '11111111-1111-4111-8111-111111111111';
const serviceId = '22222222-2222-4222-8222-222222222222';
const originalOrg = process.env.SENIORSOCIAL_ORG_ID;
afterEach(() => {
  if (originalOrg === undefined) delete process.env.SENIORSOCIAL_ORG_ID;
  else process.env.SENIORSOCIAL_ORG_ID = originalOrg;
});

function repository(overrides: Partial<ServicesRepository> = {}): ServicesRepository {
  return {
    search: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn().mockResolvedValue(null),
    listCategories: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as ServicesRepository;
}

describe('WP-010 locked public route shapes', () => {
  it('maps deterministic search pagination to PageMeta', async () => {
    process.env.SENIORSOCIAL_ORG_ID = orgId;
    const store = repository({ search: vi.fn().mockResolvedValue({ items: [], nextCursor: '20' }) });
    const response = await createSearchServicesHandler(() => store)(new Request('http://local/api/v1/services?q=comida&locale=es&limit=20'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [], meta: { next_cursor: '20' } });
    expect(store.search).toHaveBeenCalledWith(orgId, expect.objectContaining({ query: 'comida', locale: 'es', limit: 20 }));
  });

  it('rejects malformed filters before querying storage', async () => {
    process.env.SENIORSOCIAL_ORG_ID = orgId;
    const store = repository();
    const response = await createSearchServicesHandler(() => store)(new Request('http://local/api/v1/services?locale=fr'));
    expect(response.status).toBe(422);
    expect(store.search).not.toHaveBeenCalled();
  });

  it('rejects an unsafe or excessive cursor before querying storage', async () => {
    process.env.SENIORSOCIAL_ORG_ID = orgId;
    const store = repository();
    const response = await createSearchServicesHandler(() => store)(new Request('http://local/api/v1/services?cursor=9007199254740991'));
    expect(response.status).toBe(422);
    expect(store.search).not.toHaveBeenCalled();
  });

  it('does not disclose an absent or cross-tenant service', async () => {
    process.env.SENIORSOCIAL_ORG_ID = orgId;

    const response = await createGetServiceHandler(() => repository())(
      new Request(`http://local/api/v1/services/${serviceId}`), { params: Promise.resolve({ serviceId }) },
    );
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty('org_id');
  });

  it('returns the locked category page envelope', async () => {
    process.env.SENIORSOCIAL_ORG_ID = orgId;
    const items = [{ id: serviceId, label_en: 'Food', label_es: 'Alimentos' }];
    const response = await createListCategoriesHandler(() => repository({ listCategories: vi.fn().mockResolvedValue(items) }))();
    expect(await response.json()).toEqual({ items });
  });
});
