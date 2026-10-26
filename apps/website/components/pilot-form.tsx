'use client';

import { CheckCircle2, MessageCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type FormEvent, type ReactNode } from 'react';
import { OPTIONS, validatePilot, type PilotField, type PilotInput } from '../lib/pilot';
import { primaryButton, whatsappButton } from './buttons';

const EMPTY: PilotInput = {
  fullName: '',
  company: '',
  vessels: '',
  vesselCount: '',
  vesselType: '',
  whatsapp: '',
  email: '',
  homePort: '',
  currentTool: '',
  message: '',
  consent: false,
  website: '',
};

const input =
  'mt-1.5 block min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-base outline-none transition focus:border-brand focus:ring-2 focus:ring-brand/20 aria-[invalid=true]:border-bad';

/**
 * The Founding Operator Program form. Sent as JSON in a POST body (never in the URL); on
 * success it shows a WhatsApp button as the next step, when a number is configured.
 */
export function PilotForm({ whatsappHref }: { whatsappHref: string | null }) {
  const t = useTranslations('pilot');
  const locale = useLocale();
  const [values, setValues] = useState<PilotInput>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<PilotField, string>>>({});
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [failure, setFailure] = useState<'rateLimited' | 'failed' | null>(null);

  const set = (field: keyof PilotInput, value: string | boolean) => {
    setValues((current) => ({ ...current, [field]: value }));
    if (errors[field as PilotField]) setErrors((current) => ({ ...current, [field]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = validatePilot(values);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length) {
      document.getElementById(`pilot-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setState('sending');
    try {
      const response = await fetch('/api/pilot', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...values, locale }),
      });
      if (response.ok) {
        setState('sent');
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }
      const body = (await response.json().catch(() => ({}))) as { errors?: typeof errors };
      if (body.errors) setErrors(body.errors);
      setFailure(response.status === 429 ? 'rateLimited' : 'failed');
    } catch {
      setFailure('failed');
    }
    setState('idle');
  }

  if (state === 'sent')
    return (
      <div
        role="status"
        className="rounded-2xl border border-line bg-surface p-8 text-center shadow-[var(--shadow-card)]"
      >
        <CheckCircle2 aria-hidden className="mx-auto size-12 text-ok" />
        <h2 className="mt-4 text-2xl font-bold">{t('successTitle')}</h2>
        <p className="mx-auto mt-3 max-w-md leading-relaxed text-muted">{t('successText')}</p>
        {whatsappHref && (
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className={`${whatsappButton} mt-6`}
          >
            <MessageCircle aria-hidden className="size-4" />
            {t('successCta')}
          </a>
        )}
      </div>
    );

  const field = (name: PilotField, control: ReactNode, required = false, hint?: string) => (
    <div>
      <label htmlFor={`pilot-${name}`} className="block text-sm font-semibold">
        {t(`fields.${name}`)}
        {required && (
          <span className="text-bad" aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      {control}
      {hint && !errors[name] && (
        <p id={`pilot-${name}-hint`} className="mt-1.5 text-xs text-muted">
          {hint}
        </p>
      )}
      {errors[name] && (
        <p id={`pilot-${name}-error`} className="mt-1.5 text-sm text-bad">
          {t(`errors.${errors[name]}`)}
        </p>
      )}
    </div>
  );

  const aria = (name: PilotField, hint = false) => ({
    id: `pilot-${name}`,
    name,
    'aria-invalid': errors[name] ? true : undefined,
    'aria-describedby': errors[name]
      ? `pilot-${name}-error`
      : hint
        ? `pilot-${name}-hint`
        : undefined,
  });

  const text = (
    name: 'fullName' | 'company' | 'vessels' | 'whatsapp' | 'email',
    options: { required?: boolean; type?: string; autoComplete?: string; hint?: string } = {},
  ) =>
    field(
      name,
      <input
        {...aria(name, !!options.hint)}
        type={options.type ?? 'text'}
        required={options.required}
        autoComplete={options.autoComplete}
        dir={options.type === 'tel' || options.type === 'email' ? 'ltr' : undefined}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
        className={`${input} ${options.type === 'tel' || options.type === 'email' ? 'rtl:text-right' : ''}`}
      />,
      options.required,
      options.hint,
    );

  const select = (name: keyof typeof OPTIONS) =>
    field(
      name,
      <select
        {...aria(name)}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
        className={input}
      >
        <option value="">{t('choose')}</option>
        {OPTIONS[name].map((option) => (
          <option key={option} value={option}>
            {t(`options.${name}.${option}`)}
          </option>
        ))}
      </select>,
    );

  return (
    <form
      noValidate
      onSubmit={submit}
      className="relative grid gap-5 rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:grid-cols-2 sm:p-8"
    >
      <h2 className="text-xl font-bold sm:col-span-2">{t('formTitle')}</h2>
      {text('fullName', { required: true, autoComplete: 'name' })}
      {text('company', { required: true, autoComplete: 'organization' })}
      <div className="sm:col-span-2">
        {text('vessels', { required: true, hint: t('fields.vesselsHint') })}
      </div>
      {select('vesselCount')}
      {select('vesselType')}
      {text('whatsapp', {
        required: true,
        type: 'tel',
        autoComplete: 'tel',
        hint: t('fields.whatsappHint'),
      })}
      {text('email', { type: 'email', autoComplete: 'email' })}
      {select('homePort')}
      {select('currentTool')}
      <div className="sm:col-span-2">
        {field(
          'message',
          <textarea
            {...aria('message')}
            rows={4}
            value={values.message}
            onChange={(event) => set('message', event.target.value)}
            className={input}
          />,
        )}
      </div>

      {/* Honeypot: clipped to nothing and skipped by keyboard and screen readers; only bots fill it. */}
      <div aria-hidden className="sr-only">
        <label htmlFor="pilot-website">Website</label>
        <input
          id="pilot-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={values.website}
          onChange={(event) => set('website', event.target.value)}
        />
      </div>

      <div className="sm:col-span-2">
        <label className="flex items-start gap-3">
          <input
            id="pilot-consent"
            type="checkbox"
            checked={values.consent}
            aria-invalid={errors.consent ? true : undefined}
            aria-describedby={errors.consent ? 'pilot-consent-error' : undefined}
            onChange={(event) => set('consent', event.target.checked)}
            className="mt-1 size-5 shrink-0 accent-[var(--color-brand)]"
          />
          <span className="leading-relaxed">
            {t('fields.consent')}
            <span className="text-bad" aria-hidden>
              {' '}
              *
            </span>
          </span>
        </label>
        {errors.consent && (
          <p id="pilot-consent-error" className="mt-1.5 text-sm text-bad">
            {t('errors.consent')}
          </p>
        )}
      </div>

      {failure && (
        <p role="alert" className="rounded-xl bg-bad-bg p-4 text-sm text-bad sm:col-span-2">
          {t(`errors.${failure}`)}
        </p>
      )}

      <div className="flex flex-col gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={state === 'sending'}
          className={`${primaryButton} w-full disabled:opacity-60 sm:w-auto sm:self-start`}
        >
          {state === 'sending' ? t('sending') : t('submit')}
        </button>
        <p className="text-xs text-muted">{t('privacy')}</p>
      </div>
    </form>
  );
}
