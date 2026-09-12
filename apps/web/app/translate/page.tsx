import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { createDefaultTranslationRuntime } from '../api/v1/admin/translations/_shared';
import TranslationWorkbench, { type TranslationLocale } from './workbench';

export default async function TranslationPage() {
  const stored = await cookies();
  const cookieHeader = stored.getAll().map(item => `${item.name}=${encodeURIComponent(item.value)}`).join('; ');
  try {
    await createDefaultTranslationRuntime().execute(new Request('http://local/translate',{headers:{cookie:cookieHeader}}),(actor,workflow)=>workflow.list(actor));
  } catch { notFound(); }
  const locale: TranslationLocale = stored.get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  return <TranslationWorkbench locale={locale} />;
}
