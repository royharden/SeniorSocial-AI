import type { RideState } from './types.ts';

const transitions: Readonly<Record<RideState, readonly RideState[]>> = {
  draft: ['requested', 'cancelled'],
  requested: ['waiting_for_dispatcher', 'cancelled'],
  waiting_for_dispatcher: ['confirmed_by', 'cancelled', 'unable_to_fulfill'],
  confirmed_by: ['completed', 'cancelled', 'unable_to_fulfill'],
  completed: [],
  cancelled: [],
  unable_to_fulfill: [],
};

export function canTransition(from: RideState, to: RideState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: RideState, to: RideState, providerEvidence: string | null): void {
  if (!canTransition(from, to)) throw new RideConflict(`Illegal ride transition: ${from} -> ${to}`);
  if (to === 'confirmed_by' && !providerEvidence?.trim()) {
    throw new RideConflict('Provider confirmation evidence is required');
  }
}

export class RideConflict extends Error {
  readonly status = 409;
}
