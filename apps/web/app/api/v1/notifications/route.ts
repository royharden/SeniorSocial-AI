import { authenticated, json } from './_shared';
import { readCookie } from '../../../(auth)/auth/_shared';
import { createResidentRepository } from '../../../../../../packages/notify/src/resident';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return authenticated(request, async (identity, client, recheck) => {
    const requestedLocale = readCookie(request, 'seniorsocial.locale.v1');
    const locale = requestedLocale === 'es' || requestedLocale === 'en' ? requestedLocale : undefined;
    const page = await createResidentRepository(client).list(identity, new URL(request.url).searchParams.get('cursor') ?? undefined, locale, recheck);
    return json(page);
  });
}
