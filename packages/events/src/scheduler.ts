import type { EventJobQueue, ReminderScheduler } from './types.ts';

export function createReminderScheduler(queue: EventJobQueue): ReminderScheduler {
  return {
    schedule(request) {
      return queue.enqueue('events.reminder.schedule', {
        idempotency_key: request.idempotencyKey,
        event_id: request.eventId,
        org_id: request.orgId,
        user_id: request.userId,
        purpose: request.purpose,
      }, request.dueAt);
    },
  };
}
