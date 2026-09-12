import type { PgBoss } from 'pg-boss';
import { validPrintPayload, type Identity, type PrintPayload, type PrintService } from '@seniorsocial/notify';

export const PRINT_QUEUE = 'notify.render.print';
export function createBossPrintQueue(boss: Pick<PgBoss,'send'>) {
  return { async enqueue(identity: Identity, payload: PrintPayload) {
    if (!validPrintPayload(payload) || payload.org_id !== identity.orgId || payload.user_id !== identity.userId) throw new Error('Unavailable');
    const id = await boss.send(PRINT_QUEUE,payload,{singletonKey:payload.idempotency_key,retryLimit:5,retryDelay:60});
    // Null may be an identical outstanding request or a caller key collision.
    // Never claim publication/delivery in either case; the producer can retry.
    return {published:id !== null};
  } };
}
export function createPrintConsumer(service: Pick<PrintService,'consume'>, trustedOrgId: string) {
  return async (name: string, data: unknown) => {
    if (name !== PRINT_QUEUE || !validPrintPayload(data) || data.org_id !== trustedOrgId) throw new Error('Unavailable');
    // Payload is only a locator. The shared boundary requires an exact durable
    // request previously authorized by a trusted producer before reading source.
    return service.consume({orgId:data.org_id,userId:data.user_id},data);
  };
}
export async function registerPrintConsumer(boss: PgBoss, consume: ReturnType<typeof createPrintConsumer>) {
  await boss.createQueue(PRINT_QUEUE,{policy:'exclusive'});
  if ((await boss.getQueue(PRINT_QUEUE))?.policy !== 'exclusive') throw new Error('Print queue policy requires explicit migration');
  await boss.work<PrintPayload>(PRINT_QUEUE,async jobs => { for (const job of jobs) await consume(PRINT_QUEUE,job.data); });
}
