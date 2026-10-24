import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AuthShell } from '../../components/auth-shell';
import { supabasePublic } from '../../lib/supabase-config';
import { supabaseServer } from '../../server/session';
import { ResetForm } from './reset-form';

/** Reached from the reset link (already signed in by it), or by a signed-in person. */
export default async function ResetPasswordPage() {
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims) redirect('/login?link=expired');
  // Supabase only changes the password of someone with a two-step code after that code.
  const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (level?.nextLevel === 'aal2' && level.currentLevel !== 'aal2')
    redirect('/mfa?next=/reset-password');
  const t = await getTranslations('auth');
  return (
    <AuthShell title={t('resetTitle')}>
      <ResetForm {...supabasePublic()} />
    </AuthShell>
  );
}
