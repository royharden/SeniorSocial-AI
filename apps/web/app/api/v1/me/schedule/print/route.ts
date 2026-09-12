import { AssistanceScheduleUnavailableError, createPostgresAssistanceScheduleAdapter } from '@seniorsocial/assistance';
import { createPostgresRideScheduleAdapter, isRideScheduleUnavailableError } from '@seniorsocial/rides';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { authenticated, json } from '../../../notifications/_shared';
import { createPostgresEventScheduleSource, createPrintService, createRegisteredScheduleSource, currentWeek, type ScheduleSource } from '../../../../../../../../packages/notify/src/schedule';
import type { DatabaseClient } from '../../../../../../../../packages/db/src/index';
import { printableHtml } from '../../../../../../../../packages/notify/src/print';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
function trustedLocale(request: Request): 'en' | 'es' {
 const encoded = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(`${LOCALE_STORAGE_KEY}=`))?.slice(LOCALE_STORAGE_KEY.length + 1);
 if (encoded === undefined) return 'en';
 try { return decodeURIComponent(encoded) === 'es' ? 'es' : 'en'; } catch { return 'en'; }
}
export function createPublicScheduleSource(client: DatabaseClient): ScheduleSource {
 const assistance = createPostgresAssistanceScheduleAdapter(client);
 const rides = createPostgresRideScheduleAdapter(client);
 return createRegisteredScheduleSource([
  {key:'events',source:createPostgresEventScheduleSource(client)},
  {
   ...rides,
   isUnavailableError:isRideScheduleUnavailableError,
  },
  {
   ...assistance,
   isUnavailableError:error => error instanceof AssistanceScheduleUnavailableError
    && error.code === 'assistance_schedule_unavailable',
  },
 ]);
}
export function createPrintHandler(source: ScheduleSource | ((client: DatabaseClient) => ScheduleSource)) {
 return async (request: Request) => {
  return authenticated(request, async (identity, client, recheck) => {
    const query = new URL(request.url).searchParams;
    const weekOf = query.get('week_of') ?? currentWeek();
    const key = query.get('idempotency_key');
    const service = createPrintService(client,typeof source === 'function' ? source(client) : source);
    const snapshot = key === null ? await service.current(identity,weekOf,recheck)
      : await service.render(identity,{org_id:identity.orgId,user_id:identity.userId,week_of:weekOf,idempotency_key:key},recheck);
    await recheck();
    if (!request.headers.get('accept')?.includes('text/html')) return json(snapshot);
    return new Response(printableHtml(snapshot, trustedLocale(request)), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'", 'x-content-type-options': 'nosniff' } });
  });
 };
}
export const GET = createPrintHandler(createPublicScheduleSource);
