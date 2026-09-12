import { expect,it,vi } from 'vitest';
import { createBossPrintQueue,createPrintConsumer,PRINT_QUEUE } from '../../../packages/worker/src/print.ts';
import { validPrintPayload } from '../../../packages/notify/src/schedule.ts';
import { identity,orgId,userId,otherOrg } from './fixture.ts';

// what_bug_this_catches: queue aliases, extra locator/authority fields, invalid civil
// dates or cross-tenant payloads reach rendering and mutate print state.
it('validates the exact print payload before publication or consumption',async () => {
  const payload = {idempotency_key:'print-test-1',org_id:orgId,user_id:userId,week_of:'2026-09-07'};
  const send = vi.fn(() => Promise.resolve('queue-id'));
  const queue = createBossPrintQueue({send});
  await queue.enqueue(identity,payload);
  expect(send).toHaveBeenCalledWith('notify.render.print',payload,expect.objectContaining({singletonKey:payload.idempotency_key}));
  const snapshot = {as_of:'2026-09-10T12:00:00Z',source_version:'synthetic:v1',items:[]};
  const render = vi.fn(() => Promise.resolve(snapshot));
  const consume = createPrintConsumer({consume:render},orgId);
  for (const input of [null,{}, {...payload,job_id:'arbitrary'}, {...payload,week_of:'2026-02-30'}, {...payload,user_id:'bad'}, {...payload,org_id:otherOrg}]) {
    if (input && 'org_id' in input && input.org_id === otherOrg) expect(validPrintPayload(input)).toBe(true);
    else expect(validPrintPayload(input)).toBe(false);
    await expect(consume(PRINT_QUEUE,input)).rejects.toThrow('Unavailable');
  }
  await expect(consume('notify.print',payload)).rejects.toThrow('Unavailable');
  await expect(queue.enqueue(identity,{...payload,org_id:otherOrg})).rejects.toThrow('Unavailable');
  expect(render).not.toHaveBeenCalled(); expect(send).toHaveBeenCalledTimes(1);
  expect(await consume(PRINT_QUEUE,payload)).toEqual(snapshot);
  expect(render).toHaveBeenCalledWith(identity,payload);
});
