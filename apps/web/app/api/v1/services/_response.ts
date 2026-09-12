import { ServiceContextUnavailable, ServiceForbidden } from './_context';
import { CsvDocumentError, ServiceValidationError } from '@seniorsocial/services';

export class ServiceInputError extends Error {}

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function serviceError(error: unknown): Response {
  if (error instanceof ServiceInputError || error instanceof CsvDocumentError || error instanceof ServiceValidationError) {
    return noStoreJson({ type: 'about:blank', title: error.message, status: 422 }, 422);
  }
  if (error instanceof ServiceForbidden) {
    return noStoreJson({ type: 'about:blank', title: 'Forbidden', status: 403 }, 403);
  }
  const databaseCode = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  if (databaseCode === '23503' || databaseCode === '23505' || databaseCode === '23514') {
    return noStoreJson({ type: 'about:blank', title: 'Service input is invalid', status: 422 }, 422);
  }
  if (error instanceof ServiceContextUnavailable) {
    return noStoreJson({ type: 'about:blank', title: 'Service context unavailable', status: 503 }, 503);
  }
  return noStoreJson({ type: 'about:blank', title: 'Directory request failed', status: 500 }, 500);
}
