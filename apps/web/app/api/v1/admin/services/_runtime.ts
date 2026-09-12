import { createServicesService } from '@seniorsocial/services';
import { servicesRepository } from '../../services/_runtime';

export type AdminServices = ReturnType<typeof createServicesService>;
let runtime: AdminServices | undefined;

export function adminServicesRuntime(): AdminServices {
  if (runtime) return runtime;
  runtime = createServicesService(servicesRepository());
  return runtime;
}
