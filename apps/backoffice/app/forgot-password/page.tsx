import { getTranslations } from 'next-intl/server';
import { AuthShell } from '../../components/auth-shell';
import { supabasePublic } from '../../lib/supabase-config';
import { ForgotForm } from './forgot-form';

export default async function ForgotPasswordPage() {
  const t = await getTranslations('auth');
  return (
    <AuthShell title={t('forgotTitle')}>
      <ForgotForm {...supabasePublic()} />
    </AuthShell>
  );
}
