'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { normalizeHex, readableOn } from '@vs/shared/color';
import { Alert, Button, Card, Field, Input } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { useTRPC } from '../../../lib/trpc';

const LOGO_MAX_BYTES = 200 * 1024;

/** Colour pairs that suit the river; one tap sets both. The first is the Riverdesk default. */
const PRESETS = [
  ['#165a5c', '#c58b3c'],
  ['#1d3557', '#e9c46a'],
  ['#7a1e3a', '#d4a03c'],
  ['#2f4f3a', '#c9a227'],
  ['#1e4f9c', '#f2b134'],
  ['#2b2d42', '#ef8354'],
] as const;

const TEXT_FIELDS = ['phone', 'whatsapp', 'email', 'website', 'addressAr', 'addressEn'] as const;
type Form = Record<'primaryColor' | 'secondaryColor' | (typeof TEXT_FIELDS)[number], string>;

/** Debounces a value, so the preview is not re-rendered on every keystroke. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * Branding: the logo, two colours and the contact block every document prints, with a live
 * preview of a voucher (made-up guests) in the chosen language.
 */
export function BrandingCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('branding');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const branding = useQuery(trpc.settings.branding.queryOptions());
  const [form, setForm] = useState<Form | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const uiLocale = useLocale();
  const [previewLocale, setPreviewLocale] = useState<'ar' | 'en' | 'both'>(
    uiLocale === 'en' ? 'en' : 'ar',
  );

  useEffect(() => {
    if (branding.data)
      setForm({
        primaryColor: branding.data.primaryColor,
        secondaryColor: branding.data.secondaryColor,
        ...(Object.fromEntries(TEXT_FIELDS.map((k) => [k, branding.data[k] ?? ''])) as Record<
          (typeof TEXT_FIELDS)[number],
          string
        >),
      });
  }, [branding.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.settings.branding.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.settings.brandingPreview.queryKey() });
  };
  const save = useMutation(
    trpc.settings.updateBranding.mutationOptions({
      onSuccess: () => {
        setNotice(t('saved'));
        refresh();
      },
    }),
  );
  const logo = useMutation(trpc.settings.setLogo.mutationOptions({ onSuccess: refresh }));

  // The preview uses only valid colours; a half-typed one keeps the last good colour.
  const draft = useDebounced(form, 400);
  const primary = normalizeHex(draft?.primaryColor ?? '');
  const secondary = normalizeHex(draft?.secondaryColor ?? '');
  const preview = useQuery(
    trpc.settings.brandingPreview.queryOptions(
      {
        locale: previewLocale,
        ...(primary ? { primaryColor: primary } : {}),
        ...(secondary ? { secondaryColor: secondary } : {}),
        ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, draft?.[k] || null])),
        email: draft?.email && draft.email.includes('@') ? draft.email : null,
      },
      { enabled: draft !== null, placeholderData: (previous) => previous },
    ),
  );

  function pickFile(file: File | undefined) {
    setFileError(null);
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) return setFileError(t('logoType'));
    if (file.size > LOGO_MAX_BYTES) return setFileError(t('logoTooBig'));
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1] ?? '';
      logo.mutate({ base64 });
    };
    reader.readAsDataURL(file);
  }

  if (!form) return null;
  const set = (key: keyof Form, value: string) => setForm({ ...form, [key]: value });
  const failed = [save, logo].find((m) => m.isError);

  return (
    <Card title={t('title')}>
      <p className="mb-4 text-sm text-muted">{t('intro')}</p>
      {notice && !failed && (
        <div className="mb-3">
          <Alert tone="ok">{notice}</Alert>
        </div>
      )}
      {failed && (
        <div className="mb-3">
          <Alert tone="bad">{errorText(failed.error)}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            setNotice(null);
            save.mutate({
              primaryColor: form.primaryColor,
              secondaryColor: form.secondaryColor,
              ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, form[k].trim() || null])),
            });
          }}
        >
          <section>
            <h3 className="text-sm font-medium">{t('logo')}</h3>
            <p className="mb-2 text-xs text-muted">{t('logoHelp')}</p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex h-16 w-40 items-center justify-center rounded-lg border border-dashed border-line bg-white p-2">
                {branding.data?.logo ? (
                  <img src={branding.data.logo} alt={t('logo')} className="max-h-full max-w-full" />
                ) : (
                  <span className="text-xs text-muted">{t('noLogo')}</span>
                )}
              </div>
              {canWrite && (
                <>
                  <label className="cursor-pointer rounded-lg border border-line px-3 py-2 text-sm hover:border-brand">
                    {branding.data?.logo ? t('replace') : t('upload')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      onChange={(e) => {
                        pickFile(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                  {branding.data?.logo && (
                    <Button variant="ghost" onClick={() => logo.mutate({ base64: '' })}>
                      {t('remove')}
                    </Button>
                  )}
                </>
              )}
            </div>
            {fileError && <p className="mt-2 text-sm text-bad">{fileError}</p>}
          </section>

          <section>
            <h3 className="text-sm font-medium">{t('colours')}</h3>
            <p className="mb-2 text-xs text-muted">{t('coloursHelp')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {(['primaryColor', 'secondaryColor'] as const).map((key) => {
                const hex = normalizeHex(form[key]);
                return (
                  <Field key={key} label={t(key)}>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        aria-label={t(key)}
                        disabled={!canWrite}
                        value={hex ?? '#000000'}
                        onChange={(e) => set(key, e.target.value)}
                        className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-line bg-surface p-1"
                      />
                      <Input
                        dir="ltr"
                        disabled={!canWrite}
                        value={form[key]}
                        aria-invalid={hex ? undefined : true}
                        onChange={(e) => set(key, e.target.value)}
                      />
                    </div>
                    {hex && readableOn(hex) !== hex && (
                      <span className="mt-1 block text-xs text-muted">{t('darkened')}</span>
                    )}
                  </Field>
                );
              })}
            </div>
            {canWrite && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted">{t('presets')}</span>
                {PRESETS.map(([p, s]) => (
                  <button
                    key={p}
                    type="button"
                    aria-label={`${p} ${s}`}
                    onClick={() => setForm({ ...form, primaryColor: p, secondaryColor: s })}
                    className={`flex h-8 w-12 overflow-hidden rounded-full border-2 ${
                      form.primaryColor === p && form.secondaryColor === s
                        ? 'border-ink'
                        : 'border-line'
                    }`}
                  >
                    <span className="h-full w-2/3" style={{ background: p }} />
                    <span className="h-full w-1/3" style={{ background: s }} />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-medium">{t('contact')}</h3>
            <p className="mb-2 text-xs text-muted">{t('contactHelp')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {TEXT_FIELDS.map((key) => (
                <Field key={key} label={t(key)}>
                  <Input
                    dir={key === 'addressAr' ? 'rtl' : 'ltr'}
                    type={key === 'email' ? 'email' : 'text'}
                    disabled={!canWrite}
                    value={form[key]}
                    onChange={(e) => set(key, e.target.value)}
                  />
                </Field>
              ))}
            </div>
          </section>

          {canWrite && (
            <div>
              <Button
                type="submit"
                disabled={
                  save.isPending ||
                  !normalizeHex(form.primaryColor) ||
                  !normalizeHex(form.secondaryColor)
                }
              >
                {t('save')}
              </Button>
            </div>
          )}
        </form>

        <section className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-medium">{t('preview')}</h3>
              <p className="text-xs text-muted">{t('previewHelp')}</p>
            </div>
            <div className="flex gap-1 text-sm">
              {(['ar', 'en', 'both'] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => setPreviewLocale(l)}
                  className={`rounded-full px-3 py-1 ${previewLocale === l ? 'bg-brand text-brand-ink' : 'border border-line'}`}
                >
                  {l === 'ar' ? 'العربية' : l === 'en' ? 'English' : t('both')}
                </button>
              ))}
            </div>
          </div>
          <A4Preview html={preview.data ?? ''} title={t('preview')} />
        </section>
      </div>
    </Card>
  );
}

const A4_WIDTH = 794; // px at 96 dpi
const A4_HEIGHT = 1123;

/** The document at A4 size, scaled to fit the column; sandboxed with no scripts. */
function A4Preview({ html, title }: { html: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setScale(Math.min(1, (entry?.contentRect.width ?? A4_WIDTH) / A4_WIDTH)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={box}
      dir="ltr"
      className="overflow-hidden rounded-lg border border-line bg-white shadow-sm"
      style={{ height: A4_HEIGHT * scale }}
    >
      <iframe
        title={title}
        sandbox=""
        srcDoc={html}
        style={{
          width: A4_WIDTH,
          height: A4_HEIGHT,
          border: 0,
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
        }}
      />
    </div>
  );
}
