import type { Me, User } from '@seniorsocial/contracts';

export const roleValues = [
  'senior',
  'caregiver',
  'staff',
  'admin',
  'partner',
  'support',
] as const satisfies Me['roles'];

export const localeValues = ['en', 'es'] as const satisfies readonly Me['locale'][];
export const modeValues = ['standard', 'easy'] as const satisfies readonly Me['mode'][];
export const accountStateValues = [
  'active',
  'held_for_review',
  'deactivated',
] as const satisfies readonly NonNullable<User['account_state']>[];
