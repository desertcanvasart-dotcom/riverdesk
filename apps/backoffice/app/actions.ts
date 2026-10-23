'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { LOCALE_COOKIE } from '../i18n/request';
import { serverCaller } from '../server/caller';
import { getSession, supabaseServer } from '../server/session';

/** Switch language: remembered in a cookie and, for staff, on their profile. */
export async function switchLocale(locale: 'ar' | 'en') {
  (await cookies()).set(LOCALE_COOKIE, locale, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
  const session = await getSession();
  if (session?.staff && !session.needsMfa) await (await serverCaller()).me.setLocale({ locale });
}

export async function signOut() {
  await (await supabaseServer()).auth.signOut();
  redirect('/login');
}
