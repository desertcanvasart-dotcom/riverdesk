'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';

/** Always answers the same way, so the page never tells whether an email has a login. */
export function ForgotForm({ url, publishableKey }: { url: string; publishableKey: string }) {
  const t = useTranslations('auth');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (sentTo) return <Alert tone="ok">{t('linkSent', { email: sentTo })}</Alert>;
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const email = String(new FormData(event.currentTarget).get('email')).trim().toLowerCase();
        setBusy(true);
        await supabaseBrowser(url, publishableKey).auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
        });
        setBusy(false);
        setSentTo(email);
      }}
    >
      <p className="text-sm text-muted">{t('forgotHelp')}</p>
      <Field label="Email">
        <Input name="email" type="email" autoComplete="username" required dir="ltr" />
      </Field>
      <Button type="submit" disabled={busy}>
        {t('sendLink')}
      </Button>
      <Link href="/login" className="text-center text-sm text-brand">
        {t('backToLogin')}
      </Link>
    </form>
  );
}
