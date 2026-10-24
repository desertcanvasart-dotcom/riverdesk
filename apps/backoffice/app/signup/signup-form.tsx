'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';

export const MIN_PASSWORD = 10;

export function SignupForm({ url, publishableKey }: { url: string; publishableKey: string }) {
  const t = useTranslations('auth');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sentTo) return <Alert tone="ok">{t('checkEmail', { email: sentTo })}</Alert>;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get('email')).trim().toLowerCase();
        const password = String(form.get('password'));
        if (password.length < MIN_PASSWORD) return setError(t('tooShort'));
        if (password !== String(form.get('confirm'))) return setError(t('mismatch'));
        setBusy(true);
        setError(null);
        const { error } = await supabaseBrowser(url, publishableKey).auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=/` },
        });
        setBusy(false);
        if (error) return setError(t('failedGeneric'));
        setSentTo(email);
      }}
    >
      <p className="text-sm text-muted">{t('createHelp')}</p>
      <Field label="Email">
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Field label={t('newPassword')} hint={t('passwordHint')}>
        <Input name="password" type="password" autoComplete="new-password" required dir="ltr" />
      </Field>
      <Field label={t('confirmPassword')}>
        <Input name="confirm" type="password" autoComplete="new-password" required dir="ltr" />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {t('create')}
      </Button>
      <Link href="/login" className="text-center text-sm text-brand">
        {t('backToLogin')}
      </Link>
    </form>
  );
}
