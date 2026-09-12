import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_STORAGE_KEY, MODE_STORAGE_KEY } from '@seniorsocial/ui';

export async function POST(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const requestHost = request.headers.get('host') ?? requestUrl.host;
  const expectedOrigin = new URL(`${requestUrl.protocol}//${requestHost}`).origin;
  if (request.headers.get('origin') !== expectedOrigin) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  const form = await request.formData();
  const mode = form.get('mode');
  const locale = form.get('locale');
  const validMode = mode === 'standard' || mode === 'easy';
  const validLocale = locale === 'en' || locale === 'es';
  const confirmedMode = validMode && form.get('confirm') === 'yes';

  if ((validMode && validLocale) || (!confirmedMode && !validLocale)) {
    return new NextResponse('Invalid preference', { status: 400 });
  }

  let returnUrl = new URL('/home', requestUrl);
  const referer = request.headers.get('referer');
  if (!confirmedMode && referer !== null) {
    try {
      const candidate = new URL(referer, requestUrl);
      if (candidate.origin === requestUrl.origin) returnUrl = candidate;
    } catch {
      // Invalid or untrusted Referer values fall back to the same-origin home route.
    }
  }

  const response = NextResponse.redirect(returnUrl, 303);
  if (confirmedMode) response.cookies.set(MODE_STORAGE_KEY, mode, { path: '/', sameSite: 'lax', httpOnly: true });
  if (validLocale) response.cookies.set(LOCALE_STORAGE_KEY, locale, { path: '/', sameSite: 'lax', httpOnly: true });
  response.cookies.set('seniorsocial.preference-actor.v1', 'self', { path: '/', sameSite: 'lax' });
  response.cookies.set('seniorsocial.preference-selected-at.v1', new Date().toISOString(), { path: '/', sameSite: 'lax' });
  return response;
}
