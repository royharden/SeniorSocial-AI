import { cookies, headers } from 'next/headers';
import { LOCALE_STORAGE_KEY } from '@seniorsocial/ui';
import { resolveIdentity } from '../../api/v1/conversations/_runtime';
import MessagesClient from './MessagesClient';
export const dynamic = 'force-dynamic';
export default async function MessagesPage() {
  const locale = (await cookies()).get(LOCALE_STORAGE_KEY)?.value === 'es' ? 'es' : 'en';
  const identity = await resolveIdentity(new Request('http://internal/messages', { headers: await headers() }));
  return <MessagesClient locale={locale} userId={identity?.userId ?? null} />;
}
