import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { loadConfig } from '@vs/shared';

/**
 * Refreshes the Supabase session cookie on every request and sends signed-out visitors to the
 * login page. Authorization itself happens on the server in every tRPC procedure.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const config = loadConfig();
  const url = config.SUPABASE_URL;
  const key = config.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return response;
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const path = request.nextUrl.pathname;
  const open =
    path.startsWith('/login') || path.startsWith('/api/') || path.startsWith('/progress');
  if (!data?.claims && !open) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico)$).*)'],
};
