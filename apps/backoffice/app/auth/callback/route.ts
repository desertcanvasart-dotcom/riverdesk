import { NextResponse, type NextRequest } from 'next/server';
import { supabaseServer } from '../../../server/session';

export const dynamic = 'force-dynamic';

/**
 * Where email links land (confirm the email, reset the password): exchanges the one-time code
 * for a session in this browser, then continues to `next` (a path on this site only).
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  const next = request.nextUrl.searchParams.get('next') ?? '/';
  const target = request.nextUrl.clone();
  target.search = '';
  target.pathname = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(target);
  }
  const expired = request.nextUrl.clone();
  expired.pathname = '/login';
  expired.search = '?link=expired';
  return NextResponse.redirect(expired);
}
