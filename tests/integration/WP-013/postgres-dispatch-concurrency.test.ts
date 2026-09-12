import { describe, expect, it } from 'vitest';
import { createPostgresRideRepository, type RideSql, type RideState } from '../../../packages/rides/src/index';

const orgId = '11111111-1111-4111-8111-111111111111';
const rideId = '55555555-5555-4555-8555-555555555555';
const actorId = '33333333-3333-4333-8333-333333333333';

describe('WP-013 Postgres dispatch idempotency', () => {
  it('appends only one dispatcher transition when the same accepted dispatch completes concurrently', async () => {
    let sendState: 'not_sent' | 'sent' = 'not_sent';
    let dispatchReference: string | null = null;
    let rowReads = 0;
    let releaseInitialReads: (() => void) | undefined;
    const initialReadsReady = new Promise<void>(resolve => { releaseInitialReads = resolve; });
    const transitions: Array<Record<string, unknown>> = [{
      id: '66666666-6666-4666-8666-666666666666', actor_id: actorId,
      from_state: 'draft', to_state: 'requested', at: '2026-09-10T12:00:00.000Z',
      reason: 'ride_request_submitted', provider_evidence: null,
    }];

    const sql: RideSql = {
      async query<Row extends Record<string, unknown>>(text: string): Promise<Row[]> {
        if (text.includes('select r.*, t.to_state as state')) {
          rowReads += 1;
          if (rowReads <= 2) {
            if (rowReads === 2) releaseInitialReads?.();
            await initialReadsReady;
          }
          const state = transitions.at(-1)?.to_state as RideState;
          return [{ id: rideId, org_id: orgId, resident_id: actorId, requested_by_actor_id: actorId,
            purpose: 'Clinic', mode: 'partner_van', pickup_at: '2026-11-01T12:30:00.000Z',
            pickup_tz: 'America/New_York', pickup_location: 'Home', destination_location: 'Clinic',
            return_needed: false, send_state: sendState, dispatch_reference: dispatchReference,
            created_at: '2026-09-10T12:00:00.000Z', state } as unknown as Row];
        }
        if (text.includes('select code, verbatim_label')) return [];
        if (text.includes('select id, actor_id, from_state')) return transitions.map(item => ({ ...item, idempotency_key: 'create:ride-key' })) as unknown as Row[];
        if (text.includes("update ride_requests set send_state='sent'")) {
          if (sendState !== 'sent') { sendState = 'sent'; dispatchReference = 'provider:accepted'; return [{ id: rideId } as unknown as Row]; }
          return [];
        }
        if (text.includes('insert into ride_transitions')) {
          transitions.push({ id: `77777777-7777-4777-8777-77777777777${transitions.length}`,
            actor_id: actorId, from_state: 'requested', to_state: 'waiting_for_dispatcher',
            at: '2026-09-10T12:00:01.000Z', reason: 'dispatch_received', provider_evidence: 'provider:accepted' });
          return [];
        }
        if (text.includes('insert into audit_events')) return [];
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const repository = createPostgresRideRepository((_tenant, work) => work(sql));

    await Promise.all([
      repository.recordDispatch(orgId, rideId, actorId, { outcome: 'accepted_for_review', evidence: 'provider:accepted' }, '2026-09-10T12:00:01.000Z'),
      repository.recordDispatch(orgId, rideId, actorId, { outcome: 'accepted_for_review', evidence: 'provider:accepted' }, '2026-09-10T12:00:01.000Z'),
    ]);

    expect(transitions.filter(item => item.to_state === 'waiting_for_dispatcher')).toHaveLength(1);
  });
});
