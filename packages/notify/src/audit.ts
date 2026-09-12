import { DurableAuditSink } from '@seniorsocial/audit';
import type { DatabaseClient } from '@seniorsocial/db';
import type { AuditSink } from './types.ts';

/** At-least-once materialization: a crash after emit but before acknowledgement
 * can repeat an event. request_id identifies the original immutable pending row,
 * allowing consumers to collapse retries without discarding distinct intents.
 * Sink errors propagate; the drain never acknowledges an unpersisted event.
 */
export function createDurableNotificationAudit(client: DatabaseClient): AuditSink {
  const sink = new DurableAuditSink(client);
  return { emit: (intent, pendingId) => sink.emit({ ...intent, request_id: pendingId ?? null }) };
}
