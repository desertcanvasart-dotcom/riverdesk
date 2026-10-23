import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { claimStaffInvitation, getStaffContext } from '@vs/engine';
import { loadConfig, required } from '@vs/shared';
import { backofficeDb } from './db';
import type { Context } from './trpc';

/**
 * Verifies the Supabase session with the Auth server (getUser, not getSession, so a forged
 * cookie is rejected) and maps the user to an operator and role. Supabase JS is used for auth
 * only; all data access goes through the engine (rule 8).
 */
export async function createContext(): Promise<Context> {
  const config = loadConfig();
  const cookieStore = await cookies();
  const supabase = createServerClient(
    required(config, 'SUPABASE_URL'),
    required(config, 'SUPABASE_PUBLISHABLE_KEY'),
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {},
      },
    },
  );
  const { data } = await supabase.auth.getUser();
  if (!data.user) return { staff: null };
  const db = backofficeDb();
  const staff = await getStaffContext(db, data.user.id);
  if (staff) return { staff };
  // First sign-in of an invited person: only with an email Supabase Auth has verified.
  if (data.user.email && data.user.email_confirmed_at) {
    return { staff: await claimStaffInvitation(db, data.user.id, data.user.email) };
  }
  return { staff: null };
}
