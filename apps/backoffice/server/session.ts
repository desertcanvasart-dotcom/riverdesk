import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { claimStaffInvitation, getStaffContext, type StaffContext } from '@vs/engine';
import { loadConfig, required } from '@vs/shared';
import { backofficeDb } from './db';
import { MFA_REQUIRED } from './permissions';

export interface Session {
  authUserId: string;
  email: string | null;
  /** 'aal2' after a TOTP check in this session. */
  aal: 'aal1' | 'aal2';
  staff: StaffContext | null;
  /** True when the role requires MFA and this session has not passed it yet. */
  needsMfa: boolean;
}

export async function supabaseServer() {
  const config = loadConfig();
  const cookieStore = await cookies();
  return createServerClient(
    required(config, 'SUPABASE_URL'),
    required(config, 'SUPABASE_PUBLISHABLE_KEY'),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (list) => {
          try {
            for (const { name, value, options } of list) cookieStore.set(name, value, options);
          } catch {
            // Server components cannot set cookies; the proxy refreshes the session instead.
          }
        },
      },
    },
  );
}

/**
 * The verified session (getClaims checks the JWT), the staff link — claimed from an invitation
 * on first sign-in with a verified email — and whether MFA is still required.
 */
export async function getSession(): Promise<Session | null> {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims as
    | { sub?: string; email?: string; aal?: string; user_metadata?: { email_verified?: boolean } }
    | undefined;
  if (!claims?.sub) return null;
  const db = backofficeDb();
  let staff = await getStaffContext(db, claims.sub);
  if (!staff && claims.email) {
    const { data: user } = await supabase.auth.getUser();
    if (user.user?.email_confirmed_at && user.user.email)
      staff = await claimStaffInvitation(db, claims.sub, user.user.email);
  }
  const aal = claims.aal === 'aal2' ? 'aal2' : 'aal1';
  return {
    authUserId: claims.sub,
    email: claims.email ?? null,
    aal,
    staff,
    needsMfa: !!staff && MFA_REQUIRED.includes(staff.role) && aal !== 'aal2',
  };
}
