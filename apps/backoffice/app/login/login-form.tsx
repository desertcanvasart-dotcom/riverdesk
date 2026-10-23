'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';

export function LoginForm({ url, publishableKey }: { url: string; publishableKey: string }) {
  const t = useTranslations('login');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        const form = new FormData(event.currentTarget);
        const { error } = await supabaseBrowser(url, publishableKey).auth.signInWithPassword({
          email: String(form.get('email')),
          password: String(form.get('password')),
        });
        setBusy(false);
        if (error) return setError(t('failed'));
        router.replace('/');
        router.refresh();
      }}
    >
      <Field label={t('email')}>
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={t('password')}>
        <Input name="password" type="password" autoComplete="current-password" required dir="ltr" />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {t('submit')}
      </Button>
    </form>
  );
}
