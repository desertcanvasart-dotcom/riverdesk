import { getTranslations } from 'next-intl/server';
import { loadConfig, required } from '@vs/shared';
import { LocaleSwitch } from '../../components/locale-switch';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const config = loadConfig();
  const t = await getTranslations('login');
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <LocaleSwitch />
      </div>
      <LoginForm
        url={required(config, 'SUPABASE_URL')}
        publishableKey={required(config, 'SUPABASE_PUBLISHABLE_KEY')}
      />
    </main>
  );
}
