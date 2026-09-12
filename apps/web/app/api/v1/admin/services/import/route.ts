import type { AdminServices } from '../_runtime';
import { adminServicesRuntime } from '../_runtime';
import { adminServiceContext, requireSameOrigin, type AdminServiceContext } from '../../../services/_context';
import { serviceError, ServiceInputError, noStoreJson } from '../../../services/_response';

export function createImportServicesHandler(
  services: () => AdminServices = adminServicesRuntime,
  context: (request: Request) => Promise<AdminServiceContext> = adminServiceContext,
) {
  return async (request: Request): Promise<Response> => {
    try {
      requireSameOrigin(request);
      const actor = await context(request);
      const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('multipart/form-data')) throw new ServiceInputError('content-type must be multipart/form-data');
      const contentLength = request.headers.get('content-length');
      const declared = contentLength === null ? Number.NaN : Number(contentLength);
      if (!Number.isSafeInteger(declared) || declared < 1) {
        throw new ServiceInputError('content-length is required for CSV uploads');
      }
      if (declared > 1_100_000) throw new ServiceInputError('CSV upload is too large');
      const form = await request.formData();
      const upload = form.get('file');
      if (!(upload instanceof File)) throw new ServiceInputError('file is required');
      if (upload.size > 1_000_000) throw new ServiceInputError('CSV upload is too large');
      const report = await services().importCsv(actor, new Uint8Array(await upload.arrayBuffer()));
      return noStoreJson({
        created: report.created,
        updated: report.updated,
        rejected: report.rows.filter(row => row.outcome === 'rejected')
          .map(row => ({ row: row.row, reason: row.reasons.join('; ') })),
      });
    } catch (error) { return serviceError(error); }
  };
}

export const POST = createImportServicesHandler();
