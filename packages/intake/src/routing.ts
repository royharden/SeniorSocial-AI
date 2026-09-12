import type { IntakeAnswers, IntakeKind, IntakeRoute } from './types.ts';

const legalRoutes: Readonly<Record<string, IntakeRoute>> = Object.freeze({
  housing: { slug: 'housing', reasonCode: 'legal_housing' },
  benefits: { slug: 'benefits', reasonCode: 'legal_benefits' },
  consumer: { slug: 'legal-services', reasonCode: 'legal_consumer' },
  family: { slug: 'legal-services', reasonCode: 'legal_family' },
  estate_planning: { slug: 'legal-services', reasonCode: 'legal_estate_planning' },
  documents: { slug: 'legal-services', reasonCode: 'legal_documents' },
  other: { slug: 'legal-services', reasonCode: 'legal_other' },
});
const healthRoutes: Readonly<Record<string, IntakeRoute>> = Object.freeze({
  primary_care: { slug: 'health-navigation', reasonCode: 'health_primary_care' },
  find_care: { slug: 'health-navigation', reasonCode: 'health_find_care' },
  appointments: { slug: 'health-navigation', reasonCode: 'health_appointments' },
  home_support: { slug: 'health-navigation', reasonCode: 'health_home_support' },
  prescriptions: { slug: 'health-navigation', reasonCode: 'health_prescriptions' },
  behavioral_health: { slug: 'behavioral-health', reasonCode: 'health_behavioral' },
  insurance: { slug: 'benefits', reasonCode: 'health_insurance' },
  mobility: { slug: 'transportation', reasonCode: 'health_mobility' },
  other: { slug: 'health-navigation', reasonCode: 'health_other' },
});

/** Pure rules only: narratives are neither inspected nor sent to an AI boundary. */
export function routeIntake(kind: IntakeKind, answers: IntakeAnswers): IntakeRoute {
  const discriminator = answers.topic;
  const key = typeof discriminator === 'string' ? discriminator : 'other';
  return (kind === 'legal' ? legalRoutes[key] : healthRoutes[key]) ??
    (kind === 'legal' ? legalRoutes.other : healthRoutes.other)!;
}
