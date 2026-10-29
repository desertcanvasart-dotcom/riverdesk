'use client';

import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Field, Input } from '../../components/ui';
import { supabaseBrowser } from '../../lib/supabase-browser';

/**
 * The setup code, drawn here rather than Supabase's: theirs draws each module as its own square, so
 * at most screen sizes thin white seams cross the dark areas, and it is denser than needed. Ours
 * is one shape, whole pixels per module, medium error correction, and only what authenticators need
 * (SHA1, 6 digits and 30 seconds are their defaults). The account name carries the setup time, so
 * an entry left in the app by an earlier visit can be told apart from this one.
 */
async function setupQr(secret: string, account: string) {
  const uri = `otpauth://totp/Riverdesk:${encodeURIComponent(account)}?secret=${secret}&issuer=Riverdesk`;
  const modules = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules.size + 8;
  const svg = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    size: modules * 5,
    uri,
  };
}

/** TOTP: verify an existing factor, or enrol one first (owner, manager and finance must use MFA). */
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
  const [factor, setFactor] = useState<{
    id: string;
    setup?: { secret: string; label: string; qr: { src: string; size: number; uri: string } };
  } | null>(null);
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
        // Supabase's own link is not shown: the QR below is drawn from the secret (setupQr).
        issuer: 'Riverdesk',
        friendlyName: `Riverdesk ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      });
      if (enrolled.error) return setError(t('setupFailed'));
      const { data: user } = await supabase.auth.getUser();
      // Plain digits whatever the page language: it is stored in the authenticator app.
      const when = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date());
      const label = `${user.user?.email ?? 'Riverdesk'} (${when})`;
      const secret = enrolled.data.totp.secret;
      setFactor({
        id: enrolled.data.id,
        setup: { secret, label, qr: await setupQr(secret, label) },
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
          return setError(
            factor.setup ? t('failedSetup', { label: factor.setup.label }) : t('failed'),
          );
        }
        // Stay busy and load the next page in full: the first dashboard load can take seconds,
        // and a soft navigation left the form looking as if nothing had happened.
        setDone(true);
        window.location.assign(next);
      }}
    >
      {factor?.setup ? (
        <>
          <h2 className="font-semibold">{t('enrollTitle')}</h2>
          <p className="text-sm text-muted">{t('enrollHelp')}</p>
          {/* Exact size, whole pixels per module, white margin included: what cameras read best. */}
          <img
            src={factor.setup.qr.src}
            alt=""
            width={factor.setup.qr.size}
            height={factor.setup.qr.size}
            className="mx-auto max-w-full bg-white"
            style={{ imageRendering: 'pixelated' }}
          />
          {/* On a phone the code cannot be scanned from its own screen: open the app instead. */}
          <a href={factor.setup.qr.uri} className="mx-auto text-sm text-brand underline sm:hidden">
            {t('openApp')}
          </a>
          <p className="text-center text-sm">
            <span className="block text-muted">{t('entryName')}</span>
            <strong dir="ltr">Riverdesk · {factor.setup.label}</strong>
          </p>
          <p className="text-xs text-muted">{t('rescanHelp')}</p>
          <p className="text-center text-sm">
            <span className="block text-muted">{t('setupKey')}</span>
            {/* Grouped in fours so it can be typed into the app without scanning. */}
            <code
              className="mt-1 inline-block rounded bg-line/40 px-2 py-1 font-mono tracking-wider"
              dir="ltr"
            >
              {factor.setup.secret.match(/.{1,4}/g)?.join(' ')}
            </code>
          </p>
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
