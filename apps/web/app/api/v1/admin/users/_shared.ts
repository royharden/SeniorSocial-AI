import { createDatabaseClient } from '@seniorsocial/db';
import { adminServiceContext, requireSameOrigin, ServiceContextUnavailable, ServiceForbidden } from '../../services/_context';
import { AdminConflict, AdminForbidden, AdminInvalid, PostgresAdminRepository, createAdminService, type AdminActor } from '../../../../../../../packages/admin/src/index.ts';

export type AdminService = ReturnType<typeof createAdminService>;
let service: AdminService | undefined;
function suppressionThreshold():number{const configured=process.env.SENIORSOCIAL_ANALYTICS_K;if(configured===undefined)return 11;const value=Number(configured);if(!Number.isSafeInteger(value)||value<2)throw new ServiceContextUnavailable('SENIORSOCIAL_ANALYTICS_K is invalid');return value;}
export function adminRuntime(): AdminService {
  service ??= createAdminService(new PostgresAdminRepository(createDatabaseClient(),suppressionThreshold()));
  return service;
}
export async function adminContext(request: Request): Promise<AdminActor> {
  const context = await adminServiceContext(request);
  return { id: context.actorId, orgId: context.orgId, roles: context.roles };
}
export async function adminMutationContext(request: Request): Promise<AdminActor> {
  requireSameOrigin(request);
  return adminContext(request);
}
export async function jsonInput<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new AdminInvalid('application/json is required');
  try { return await request.json() as T; } catch { throw new AdminInvalid('valid JSON is required'); }
}
export function idempotencyKey(request:Request):string{const value=request.headers.get('idempotency-key')?.trim();if(!value)throw new AdminInvalid('Idempotency-Key is required');if(!/^[A-Za-z0-9._~-]{1,160}$/u.test(value))throw new AdminInvalid('Idempotency-Key is invalid');return value;}
export function adminResponse(error: unknown): Response {
  const status = error instanceof AdminForbidden || error instanceof ServiceForbidden ? 403 : error instanceof AdminInvalid ? 422 : error instanceof AdminConflict ? 409 : error instanceof ServiceContextUnavailable ? 503 : 500;
  return Response.json({ type: 'about:blank', title: status === 403 ? 'Forbidden' : status === 422 ? 'Unprocessable Entity' : status===409?'Conflict':'Service unavailable', status }, { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/problem+json' } });
}
export const okay = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
