'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';
import { MIN_PASSWORD } from '../signup/signup-form';

export function ResetForm({ url, publishableKey }: { url: string; publishableKey: string }) {
  const t = useTranslations('auth');
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const password = String(form.get('password'));
        if (password.length < MIN_PASSWORD) return setError(t('tooShort'));
        if (password !== String(form.get('confirm'))) return setError(t('mismatch'));
        setBusy(true);
        const { error } = await supabaseBrowser(url, publishableKey).auth.updateUser({ password });
        setBusy(false);
        if (error) return setError(t('failedGeneric'));
        router.replace('/');
        router.refresh();
      }}
    >
      <Field label={t('newPassword')} hint={t('passwordHint')}>
        <Input name="password" type="password" autoComplete="new-password" required dir="ltr" />
      </Field>
      <Field label={t('confirmPassword')}>
        <Input name="confirm" type="password" autoComplete="new-password" required dir="ltr" />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" disabled={busy}>
        {t('resetSave')}
      </Button>
    </form>
  );
}
