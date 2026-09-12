import {
  AssistanceScheduleUnavailableError,
  createPostgresAssistanceScheduleAdapter,
  type AssistanceScheduleSourceRegistration,
} from '@seniorsocial/assistance';
import type { DatabaseClient } from '@seniorsocial/db';
import {
  createPostgresRideScheduleAdapter,
  isRideScheduleUnavailableError,
  type RideScheduleSourceRegistration,
} from '../../rides/src/index.ts';
import {
  createPostgresEventScheduleSource,
  createRegisteredScheduleSource,
  type ScheduleSource,
} from '../../notify/src/schedule.ts';

export interface WorkerScheduleRegistrations {
  readonly events: ScheduleSource;
  readonly rides: RideScheduleSourceRegistration;
  readonly assistance: AssistanceScheduleSourceRegistration;
}

/** Keep background print composition identical to the authenticated public
 * route: stable events -> rides -> assistance order and typed outage isolation. */
export function composeWorkerScheduleSource(
  registrations: WorkerScheduleRegistrations,
  clock: () => Date = () => new Date(),
): ScheduleSource {
  return createRegisteredScheduleSource([
    { key: 'events', source: registrations.events },
    { ...registrations.rides, isUnavailableError: isRideScheduleUnavailableError },
    {
      ...registrations.assistance,
      isUnavailableError: error => error instanceof AssistanceScheduleUnavailableError
        && error.code === 'assistance_schedule_unavailable',
    },
  ], clock);
}

export function createWorkerScheduleSource(
  client: DatabaseClient,
  clock: () => Date = () => new Date(),
): ScheduleSource {
  return composeWorkerScheduleSource({
    events: createPostgresEventScheduleSource(client, clock),
    rides: createPostgresRideScheduleAdapter(client, clock),
    assistance: createPostgresAssistanceScheduleAdapter(client, clock),
  }, clock);
}
