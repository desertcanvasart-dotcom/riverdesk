'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';

/** TOTP: verify an existing factor, or enrol one first (owner and finance must use MFA). */
export function MfaForm({
  url,
  publishableKey,
  next,
}: {
  url: string;
  publishableKey: string;
  next: string;
}) {
  const t = useTranslations('mfa');
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(url, publishableKey), [url, publishableKey]);
  const [factor, setFactor] = useState<{ id: string; qr?: string; secret?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const verified = data?.totp.find((f) => f.status === 'verified');
      if (verified) return setFactor({ id: verified.id });
      const enrolled = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        // What the authenticator app shows next to the code.
        issuer: 'Riverdesk',
        friendlyName: `Riverdesk ${new Date().toISOString().slice(0, 10)}`,
      });
      if (enrolled.data)
        setFactor({
          id: enrolled.data.id,
          qr: enrolled.data.totp.qr_code,
          secret: enrolled.data.totp.secret,
        });
    })();
  }, [supabase]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!factor) return;
        setBusy(true);
        const code = String(new FormData(event.currentTarget).get('code')).trim();
        const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
        setBusy(false);
        if (error) return setError(t('failed'));
        router.replace(next);
        router.refresh();
      }}
    >
      {factor?.qr ? (
        <>
          <h2 className="font-semibold">{t('enrollTitle')}</h2>
          <p className="text-sm text-muted">{t('enrollHelp')}</p>
          <img src={factor.qr} alt="" className="mx-auto h-48 w-48 rounded-lg bg-white p-2" />
          {factor.secret && (
            <p className="text-center text-sm">
              <span className="block text-muted">{t('setupKey')}</span>
              {/* Grouped in fours so it can be typed into the app without scanning. */}
              <code
                className="mt-1 inline-block rounded bg-line/40 px-2 py-1 font-mono tracking-wider"
                dir="ltr"
              >
                {factor.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted">{t('verifyHelp')}</p>
      )}
      <Field label={t('code')}>
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          dir="ltr"
        />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button type="submit" disabled={busy || !factor}>
        {t('submit')}
      </Button>
    </form>
  );
}
