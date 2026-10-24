import { getTranslations } from 'next-intl/server';
import { AuthShell } from '../../components/auth-shell';
import { supabasePublic } from '../../lib/supabase-config';
import { SignupForm } from './signup-form';

/** An invited person creates their login here; the email confirmation link signs them in. */
export default async function SignupPage() {
  const t = await getTranslations('auth');
  return (
    <AuthShell title={t('createTitle')}>
      <SignupForm {...supabasePublic()} />
    </AuthShell>
  );
}
