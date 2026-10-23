import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { loadConfig, required } from '@vs/shared';
import { getSession } from '../../server/session';
import { MfaForm } from './mfa-form';

export default async function MfaPage() {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.needsMfa) redirect('/');
  const config = loadConfig();
  const t = await getTranslations('mfa');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="mb-6 text-2xl font-semibold">{t('title')}</h1>
      <MfaForm
        url={required(config, 'SUPABASE_URL')}
        publishableKey={required(config, 'SUPABASE_PUBLISHABLE_KEY')}
      />
    </main>
  );
}
