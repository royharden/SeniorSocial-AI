import { accessibilityCodes, rideModes, rideStates, type AccessibilityCondition, type RideRequestInput, type RideState } from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const idempotency = /^[A-Za-z0-9:_-]{1,160}$/u;
export const isUuid = (value: string): boolean => uuid.test(value);
export const isIdempotencyKey = (value: string): boolean => idempotency.test(value);
export const isRideState = (value: unknown): value is RideState => typeof value === 'string' && rideStates.includes(value as RideState);

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\r\n]/u.test(value);
}

function validZone(value: unknown): value is string {
  if (!text(value, 80)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function condition(value: unknown): value is AccessibilityCondition {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.code === 'string' && accessibilityCodes.includes(row.code as AccessibilityCondition['code']) && text(row.label, 120);
}

export function parseRideInput(value: unknown): RideRequestInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid ride request');
  const row = value as Record<string, unknown>;
  if (typeof row.residentId !== 'string' || !isUuid(row.residentId) || !text(row.purpose, 240) ||
    typeof row.mode !== 'string' || !rideModes.includes(row.mode as RideRequestInput['mode']) ||
    !text(row.pickupAt, 50) || Number.isNaN(Date.parse(row.pickupAt)) || !validZone(row.pickupTz) ||
    !text(row.pickupLocation, 240) || !text(row.destinationLocation, 240) || typeof row.returnNeeded !== 'boolean' ||
    !Array.isArray(row.accessibilityConditions) || row.accessibilityConditions.length > accessibilityCodes.length ||
    !row.accessibilityConditions.every(condition)) throw new Error('Invalid ride request');
  const conditions = row.accessibilityConditions;
  if (new Set(conditions.map(item => item.code)).size !== conditions.length) throw new Error('Invalid ride request');
  return {
    residentId: row.residentId, purpose: row.purpose, mode: row.mode as RideRequestInput['mode'],
    pickupAt: new Date(row.pickupAt).toISOString(), pickupTz: row.pickupTz,
    pickupLocation: row.pickupLocation, destinationLocation: row.destinationLocation,
    returnNeeded: row.returnNeeded, accessibilityConditions: conditions.map(item => ({ code: item.code, label: item.label })),
  };
}
