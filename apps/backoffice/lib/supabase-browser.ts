'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Supabase in the browser is used for sign-in and MFA only; data goes through tRPC (rule 8). */
export function supabaseBrowser(url: string, key: string) {
  return createBrowserClient(url, key);
}
