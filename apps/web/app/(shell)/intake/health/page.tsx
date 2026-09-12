import { cookies } from 'next/headers';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { IntakeForm } from '../intake-form';

export default async function HealthIntakePage() {
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <IntakeForm kind="health" locale={locale} />;
}
