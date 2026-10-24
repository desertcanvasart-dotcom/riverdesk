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
  const target = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  if (code) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return to(target);
  }
  return to('/login?link=expired');
}

/**
 * A redirect by path only: behind Railway's proxy the request URL carries the server's own
 * address (0.0.0.0:3000), so the browser resolves the path against the address it used.
 */
function to(path: string) {
  return new NextResponse(null, { status: 307, headers: { Location: path } });
}
