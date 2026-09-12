import { createHash } from 'node:crypto';
import { withOrg, type DatabaseClient } from '../../db/src/index.ts';
import type { PrintableSchedule } from '../../contracts/src/types.ts';
import { isRideState, isUuid } from './validation.ts';
import { accessibilityCodes, type AccessibilityCondition, type RideMode, type RideState } from './types.ts';

export const rideScheduleSourceKey = 'rides' as const;
export const rideScheduleUnavailable = 'ride_schedule_unavailable' as const;

export interface RideScheduleIdentity {
  readonly orgId: string;
  readonly userId: string;
}

export interface RideScheduleRequest {
  readonly id: string;
  readonly orgId: string;
  readonly residentId: string;
  readonly purpose: string;
  readonly mode: RideMode;
  readonly pickupAt: Date;
  readonly pickupTz: string;
  readonly pickupLocation: string;
  readonly destinationLocation: string;
  readonly returnNeeded: boolean;
  readonly accessibilityDetails: readonly AccessibilityCondition[];
  /** The repository must derive this from the latest immutable transition. */
  readonly state: RideState;
}

export interface RideScheduleReadPort {
  listForWeek(identity: RideScheduleIdentity, start: Date, end: Date): Promise<readonly RideScheduleRequest[]>;
}

export interface RideScheduleSource {
  read(identity: RideScheduleIdentity, weekOf: string): Promise<PrintableSchedule>;
}

export interface RideScheduleSourceRegistration {
  readonly key: typeof rideScheduleSourceKey;
  readonly source: RideScheduleSource;
}

export class RideScheduleUnavailableError extends Error {
  readonly code = rideScheduleUnavailable;

  constructor(cause?: unknown) {
    super(rideScheduleUnavailable, cause === undefined ? undefined : { cause });
    this.name = 'RideScheduleUnavailableError';
  }
}

export function isRideScheduleUnavailableError(error: unknown): error is RideScheduleUnavailableError {
  return error instanceof RideScheduleUnavailableError && error.code === rideScheduleUnavailable;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/u;

function weekBounds(weekOf: string): { start: Date; end: Date } {
  if (!isoDate.test(weekOf)) throw new RideScheduleUnavailableError();
  const start = new Date(`${weekOf}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== weekOf) {
    throw new RideScheduleUnavailableError();
  }
  return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

function item(ride: RideScheduleRequest): Record<string, unknown> {
  const details = accessibilityDetails(ride.accessibilityDetails);
  return {
    id: ride.id,
    kind: 'ride',
    state: ride.state,
    purpose: ride.purpose,
    mode: ride.mode,
    pickup_at: ride.pickupAt.toISOString(),
    pickup_tz: ride.pickupTz,
    pickup_location: ride.pickupLocation,
    destination_location: ride.destinationLocation,
    return_needed: ride.returnNeeded,
    accessibility_details: details.map(detail => ({ code: detail.code, label: detail.label })),
  };
}

/** Builds the resident-safe ride projection. The adapter and its repository
 * both enforce org, resident, and week boundaries as defense in depth. */
export function createRideScheduleSource(
  repository: RideScheduleReadPort,
  clock: () => Date = () => new Date(),
): RideScheduleSourceRegistration {
  return {
    key: rideScheduleSourceKey,
    source: {
      async read(identity, weekOf) {
        if (!isUuid(identity.orgId) || !isUuid(identity.userId)) throw new RideScheduleUnavailableError();
        const { start, end } = weekBounds(weekOf);
        const rows = await repository.listForWeek(identity, start, end);
        const items = rows
          .filter(ride => ride.orgId === identity.orgId && ride.residentId === identity.userId
            && Number.isFinite(ride.pickupAt.getTime()) && ride.pickupAt >= start && ride.pickupAt < end)
          .sort((left, right) => left.pickupAt.getTime() - right.pickupAt.getTime() || left.id.localeCompare(right.id))
          .map(item);
        const observed = clock();
        if (!Number.isFinite(observed.getTime())) throw new Error('invalid ride schedule clock');
        const digest = createHash('sha256').update(JSON.stringify([weekOf, items])).digest('hex');
        return { as_of: observed.toISOString(), source_version: `rides:v1:${digest}`, items };
      },
    },
  };
}

interface RideScheduleRow {
  id: string;
  org_id: string;
  resident_id: string;
  purpose: string;
  mode: RideMode;
  pickup_at: string;
  pickup_tz: string;
  pickup_location: string;
  destination_location: string;
  return_needed: boolean;
  accessibility_details: unknown;
  state: RideState;
}

function accessibilityDetails(value: unknown): AccessibilityCondition[] {
  if (!Array.isArray(value)) throw new RangeError('invalid ride schedule accessibility details');
  if (value.length > accessibilityCodes.length) throw new RangeError('invalid ride schedule accessibility details');
  const details = value.map(detail => {
    if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
      throw new RangeError('invalid ride schedule accessibility detail');
    }
    const row = detail as Record<string, unknown>;
    if (typeof row.code !== 'string' || !accessibilityCodes.includes(row.code as AccessibilityCondition['code'])
      || typeof row.label !== 'string' || row.label.trim().length === 0 || row.label.length > 120
      || /[\r\n]/u.test(row.label)) {
      throw new RangeError('invalid ride schedule accessibility detail');
    }
    return { code: row.code as AccessibilityCondition['code'], label: row.label };
  });
  if (new Set(details.map(detail => detail.code)).size !== details.length) {
    throw new RangeError('invalid ride schedule accessibility details');
  }
  return details;
}

function fromDatabase(row: RideScheduleRow): RideScheduleRequest {
  const pickupAt = new Date(row.pickup_at);
  if (!isUuid(row.id) || !isUuid(row.org_id) || !isUuid(row.resident_id) || !isRideState(row.state)
    || !Number.isFinite(pickupAt.getTime())) throw new RangeError('invalid ride schedule row');
  return {
    id: row.id,
    orgId: row.org_id,
    residentId: row.resident_id,
    purpose: row.purpose,
    mode: row.mode,
    pickupAt,
    pickupTz: row.pickup_tz,
    pickupLocation: row.pickup_location,
    destinationLocation: row.destination_location,
    returnNeeded: row.return_needed,
    accessibilityDetails: accessibilityDetails(row.accessibility_details),
    state: row.state,
  };
}

/** Reads current ride state only from the latest immutable transition. The
 * request row has no mutable state column and cannot override that history. */
export function createPostgresRideScheduleAdapter(
  client: DatabaseClient,
  clock: () => Date = () => new Date(),
): RideScheduleSourceRegistration {
  const repository: RideScheduleReadPort = {
    listForWeek: (identity, start, end) => withOrg(client, identity.orgId, async sql => {
      await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
      const active = await sql<{ id: string }[]>`
        select id from users
        where org_id = ${identity.orgId} and id = ${identity.userId} and account_state = 'active'
      `;
      if (active.length !== 1) throw new RideScheduleUnavailableError();
      const rows = await sql<RideScheduleRow[]>`
        select r.id, r.org_id, r.resident_id, r.purpose, r.mode,
          r.pickup_at::text, r.pickup_tz, r.pickup_location,
          r.destination_location, r.return_needed, latest.to_state as state,
          coalesce((
            select jsonb_agg(jsonb_build_object('code', detail.code, 'label', detail.verbatim_label)
              order by detail.position)
            from ride_accessibility_conditions detail
            where detail.org_id = r.org_id and detail.ride_id = r.id
          ), '[]'::jsonb) as accessibility_details
        from ride_requests r
        join lateral (
          select transition.to_state from ride_transitions transition
          where transition.org_id = r.org_id and transition.ride_id = r.id
          order by transition.at desc, transition.id desc limit 1
        ) latest on true
        where r.org_id = ${identity.orgId} and r.resident_id = ${identity.userId}
          and r.pickup_at >= ${start} and r.pickup_at < ${end}
        order by r.pickup_at, r.id
      `;
      return rows.map(fromDatabase);
    }),
  };
  return createRideScheduleSource(repository, clock);
}
