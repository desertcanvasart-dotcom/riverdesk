'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  const supabase = useMemo(() => supabaseBrowser(url, publishableKey), [url, publishableKey]);
  const [factor, setFactor] = useState<{ id: string; qr?: string; secret?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const submitting = useRef(false);

  // Enrolling twice would leave two secrets and show only one (React runs effects twice in dev).
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) return setError(t('setupFailed'));
      const verified = data.totp.find((f) => f.status === 'verified');
      if (verified) return setFactor({ id: verified.id });
      // A factor left unverified by an earlier visit cannot show its QR again, and its name would
      // clash with a new one: remove it, so the code on screen is always the one that works.
      for (const stale of data.all.filter((f) => f.status === 'unverified'))
        await supabase.auth.mfa.unenroll({ factorId: stale.id });
      const enrolled = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        // What the authenticator app shows next to the code.
        issuer: 'Riverdesk',
        friendlyName: `Riverdesk ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      });
      if (enrolled.error) return setError(t('setupFailed'));
      setFactor({
        id: enrolled.data.id,
        qr: enrolled.data.totp.qr_code,
        secret: enrolled.data.totp.secret,
      });
    })();
  }, [supabase, t]);

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        // The 6th digit submits on its own; a click on Verify right after must not send it twice.
        if (!factor || submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError(null);
        const code = String(new FormData(event.currentTarget).get('code')).trim();
        const { error } = await supabase.auth.mfa
          .challengeAndVerify({ factorId: factor.id, code })
          .catch((thrown: unknown) => ({ error: thrown }));
        if (error) {
          submitting.current = false;
          setBusy(false);
          return setError(t('failed'));
        }
        // Stay busy and load the next page in full: the first dashboard load can take seconds,
        // and a soft navigation left the form looking as if nothing had happened.
        setDone(true);
        window.location.assign(next);
      }}
    >
      {factor?.qr ? (
        <>
          <h2 className="font-semibold">{t('enrollTitle')}</h2>
          <p className="text-sm text-muted">{t('enrollHelp')}</p>
          {/* The code is dense (version 12): bigger is easier for a phone camera. */}
          <img src={factor.qr} alt="" className="mx-auto h-64 w-64 rounded-lg bg-white p-2" />
          <p className="text-xs text-muted">{t('rescanHelp')}</p>
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
          // Six digits typed or pasted: verify without a click.
          onChange={(e) => {
            if (/^[0-9]{6}$/.test(e.currentTarget.value.trim()))
              e.currentTarget.form?.requestSubmit();
          }}
        />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      {done && <Alert tone="ok">{t('opening')}</Alert>}
      <Button type="submit" disabled={busy || !factor}>
        {t('submit')}
      </Button>
    </form>
  );
}
