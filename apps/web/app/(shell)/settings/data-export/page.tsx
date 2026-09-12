import { cookies } from 'next/headers';
import { LOCALE_STORAGE_KEY, MODE_STORAGE_KEY } from '@seniorsocial/ui';
import { DataExportForm } from './data-export-form';

export default async function DataExportPage() {
  const stored = await cookies();
  const locale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const mode = stored.get(MODE_STORAGE_KEY)?.value === 'easy' ? 'easy' : 'standard';
  return <DataExportForm locale={locale} mode={mode} />;
}
