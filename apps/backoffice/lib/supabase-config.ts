import 'server-only';
import { loadConfig, required } from '@vs/shared';

/** The public Supabase settings the browser needs for sign-in (never a secret key). */
export function supabasePublic() {
  const config = loadConfig();
  return {
    url: required(config, 'SUPABASE_URL'),
    publishableKey: required(config, 'SUPABASE_PUBLISHABLE_KEY'),
  };
}
