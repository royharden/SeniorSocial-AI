import { describe, expect, it } from 'vitest';
import { AssistanceScheduleUnavailableError } from '../../../packages/assistance/src/index.ts';
import type { ScheduleSource } from '../../../packages/notify/src/schedule.ts';
import { RideScheduleUnavailableError } from '../../../packages/rides/src/index.ts';
import { composeWorkerScheduleSource, type WorkerScheduleRegistrations } from '../../../packages/worker/src/schedule.ts';
import { identity } from '../../unit/WP-009/fixture.ts';

const snapshot = (source: string, id: string): ScheduleSource => ({
  read: () => Promise.resolve({
    as_of: '2027-01-19T12:00:00.000Z',
    source_version: `${source}:v1:stable`,
    items: [{ id, ...(source === 'rides' ? { accessibility_details: [
      { code: 'wheelchair', label: 'Uses a 24-inch wheelchair' },
      { code: 'needs_an_arm', label: 'Please offer your left arm' },
    ] } : {}) }],
  }),
});

function registrations(rides: ScheduleSource = snapshot('rides', 'ride-1')): WorkerScheduleRegistrations {
  return {
    events: snapshot('events', 'event-1'),
    rides: { key: 'rides', source: rides },
    assistance: { key: 'assistance', source: snapshot('assistance', 'assistance-1') },
  };
}

describe('WP-009 background print schedule parity', () => {
  // what_bug_this_catches: queued rendering keeps the old events+assistance
  // registry, changes source order, or drops ride provenance while GET works.
  it('composes events, rides, and assistance in public route order', async () => {
    const schedule = composeWorkerScheduleSource(registrations(), () => new Date('2027-01-19T12:01:00.000Z'));
    const result = await schedule.read(identity, '2027-01-19');
    expect(result.sources).toEqual([
      expect.objectContaining({ key: 'events', status: 'available', item_count: 1 }),
      expect.objectContaining({ key: 'rides', status: 'available', item_count: 1 }),
      expect.objectContaining({ key: 'assistance', status: 'available', item_count: 1 }),
    ]);
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'event-1', schedule_source: 'events' }),
      expect.objectContaining({ id: 'ride-1', schedule_source: 'rides', accessibility_details: [
        { code: 'wheelchair', label: 'Uses a 24-inch wheelchair' },
        { code: 'needs_an_arm', label: 'Please offer your left arm' },
      ] }),
      expect.objectContaining({ id: 'assistance-1', schedule_source: 'assistance' }),
    ]);
  });

  // what_bug_this_catches: the background path either fails every print for an
  // expected ride outage or hides an unexpected/forged source defect.
  it('isolates only the typed ride unavailable signal', async () => {
    const failing = (error: Error): ScheduleSource => ({ read: () => Promise.reject(error) });
    const typed = composeWorkerScheduleSource(registrations(failing(new RideScheduleUnavailableError())),
      () => new Date('2027-01-19T12:01:00.000Z'));
    const partial = await typed.read(identity, '2027-01-19');
    expect(partial.sources).toEqual([
      expect.objectContaining({ key: 'events', status: 'available' }),
      expect.objectContaining({ key: 'rides', status: 'unavailable' }),
      expect.objectContaining({ key: 'assistance', status: 'available' }),
    ]);

    const unexpected = new Error('unexpected ride source defect');
    await expect(composeWorkerScheduleSource(registrations(failing(unexpected))).read(identity, '2027-01-19'))
      .rejects.toBe(unexpected);
    const forged = Object.assign(new Error('forged ride outage'), { code: 'ride_schedule_unavailable' });
    await expect(composeWorkerScheduleSource(registrations(failing(forged))).read(identity, '2027-01-19'))
      .rejects.toBe(forged);
  });

  // what_bug_this_catches: adding rides changes assistance's established typed
  // outage behavior in the background composition.
  it('preserves typed assistance outage isolation', async () => {
    const failingAssistance = { key: 'assistance' as const, source: {
      read: () => Promise.reject(new AssistanceScheduleUnavailableError()),
    } };
    const result = await composeWorkerScheduleSource({ ...registrations(), assistance: failingAssistance },
      () => new Date('2027-01-19T12:01:00.000Z')).read(identity, '2027-01-19');
    expect(result.sources).toEqual([
      expect.objectContaining({ key: 'events', status: 'available' }),
      expect.objectContaining({ key: 'rides', status: 'available' }),
      expect.objectContaining({ key: 'assistance', status: 'unavailable' }),
    ]);
  });
});
