import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { AuthShell } from '../../components/auth-shell';
import { Alert } from '../../components/ui';
import { supabasePublic } from '../../lib/supabase-config';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ link?: string }>;
}) {
  const { link } = await searchParams;
  const t = await getTranslations('login');
  const a = await getTranslations('auth');
  return (
    <AuthShell title={t('title')}>
      {link === 'expired' && (
        <div className="mb-4">
          <Alert tone="warn">{a('linkExpired')}</Alert>
        </div>
      )}
      <LoginForm {...supabasePublic()} />
      <div className="mt-6 flex flex-col items-center gap-3 text-sm">
        <Link href="/forgot-password" className="text-brand">
          {a('forgotLink')}
        </Link>
        <Link href="/signup" className="text-brand">
          {a('firstTime')}
        </Link>
      </div>
    </AuthShell>
  );
}
