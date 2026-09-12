import { describe, expect, it, vi } from 'vitest';
import type { AdminServices } from '../../../apps/web/app/api/v1/admin/services/_runtime';
import { createPostServiceHandler } from '../../../apps/web/app/api/v1/admin/services/route';
import { createPatchServiceHandler } from '../../../apps/web/app/api/v1/admin/services/[serviceId]/route';
import { createImportServicesHandler } from '../../../apps/web/app/api/v1/admin/services/import/route';
import { ServiceForbidden, type AdminServiceContext } from '../../../apps/web/app/api/v1/services/_context';

const context: AdminServiceContext = {
  orgId: '11111111-1111-4111-8111-111111111111',
  actorId: '22222222-2222-4222-8222-222222222222',
  roles: ['staff'],
};
const input = {
  category_id: '33333333-3333-4333-8333-333333333333',
  name_en: 'Food delivery', name_es: 'Entrega de alimentos',
  source_updated_at: '2026-09-10T12:00:00.000Z',
};
const output = {
  id: '44444444-4444-4444-8444-444444444444', org_id: context.orgId,
  name: input.name_en, category_id: input.category_id, description: '', eligibility_note: '', phone: '',
  languages: ['en', 'es'], accessibility: [], source_updated_at: input.source_updated_at,
};

function adminServices(overrides: Partial<AdminServices> = {}): AdminServices {
  return {
    create: vi.fn().mockResolvedValue(output),
    update: vi.fn().mockResolvedValue(output),
    importCsv: vi.fn().mockResolvedValue({ importId: '55555555-5555-4555-8555-555555555555', created: 1, updated: 0, rejected: 0, rows: [] }),
    ...overrides,
  } as unknown as AdminServices;
}

describe('WP-010 locked admin route shapes', () => {
  it('creates through explicit trusted context and returns the Service shape', async () => {
    const services = adminServices();
    const response = await createPostServiceHandler(() => services, async () => context)(new Request('http://local/api/v1/admin/services', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify(input),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(output);
    expect(services.create).toHaveBeenCalledWith(context, expect.objectContaining({ nameEn: input.name_en }), 'en');
  });

  it('returns opaque 404 for an absent tenant-scoped update', async () => {
    const services = adminServices({ update: vi.fn().mockResolvedValue(null) });
    const handler = createPatchServiceHandler(() => services, async () => context);
    const response = await handler(new Request('http://local/api/v1/admin/services/44444444-4444-4444-8444-444444444444', {
      method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify(input),
    }), { params: Promise.resolve({ serviceId: output.id }) });
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty('org_id');
  });

  it('passes PATCH as a partial update without synthesizing omitted fields', async () => {
    const services = adminServices();
    const handler = createPatchServiceHandler(() => services, async () => context);
    const response = await handler(new Request(`http://local/api/v1/admin/services/${output.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify({ phone: '+1-555-0100' }),
    }), { params: Promise.resolve({ serviceId: output.id }) });
    expect(response.status).toBe(200);
    expect(services.update).toHaveBeenCalledWith(context, output.id, { phone: '+1-555-0100' }, 'en');
  });

  it('rejects a non-operator before invoking any mutation', async () => {
    const services = adminServices();
    const response = await createPostServiceHandler(() => services, async () => { throw new ServiceForbidden(); })(new Request('http://local/api/v1/admin/services', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://local' }, body: JSON.stringify(input),
    }));
    expect(response.status).toBe(403);
    expect(services.create).not.toHaveBeenCalled();
  });

  it('reports rejected CSV rows without hiding accepted counts', async () => {
    const services = adminServices({ importCsv: vi.fn().mockResolvedValue({
      importId: null, created: 1, updated: 1, rejected: 1,
      rows: [{ row: 3, externalId: 'unsafe', outcome: 'rejected', reasons: ['formula-leading value'] }],
    }) });
    const form = new FormData();
    form.set('file', new File(['external_id,name_en\n1,Food'], 'services.csv', { type: 'text/csv' }));
    const response = await createImportServicesHandler(() => services, async () => context)(new Request('http://local/api/v1/admin/services/import', { method: 'POST', headers: { origin: 'http://local', 'content-length': '256' }, body: form }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ created: 1, updated: 1, rejected: [{ row: 3, reason: 'formula-leading value' }] });
  });

  it('rejects an unbounded chunked CSV upload before allocating its multipart body', async () => {
    const services = adminServices();
    const form = new FormData();
    form.set('file', new File(['external_id,name_en\n1,Food'], 'services.csv', { type: 'text/csv' }));
    const response = await createImportServicesHandler(() => services, async () => context)(new Request('http://local/api/v1/admin/services/import', {
      method: 'POST', headers: { origin: 'http://local' }, body: form,
    }));
    expect(response.status).toBe(422);
    expect(services.importCsv).not.toHaveBeenCalled();
  });

  it('rejects cross-origin writes before resolving actor or storage', async () => {
    const services = adminServices();
    const resolveContext = vi.fn(async () => context);
    const response = await createPostServiceHandler(() => services, resolveContext)(new Request('http://local/api/v1/admin/services', {
      method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify(input),
    }));
    expect(response.status).toBe(403);
    expect(resolveContext).not.toHaveBeenCalled();
    expect(services.create).not.toHaveBeenCalled();
  });
});
