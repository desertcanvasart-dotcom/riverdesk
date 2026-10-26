'use client';

import { useMutation } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Dialog } from '../../../../components/dialog';
import { Alert, Badge, Button, Field, Input, Select } from '../../../../components/ui';
import { useErrorText } from '../../../../lib/errors';
import { formatDate } from '../../../../lib/format';
import { newRequestKey, useTRPC } from '../../../../lib/trpc';
import { CountrySelect, CountryName } from '../../../../components/country-select';

/** Check-in details (Batch D2): optional text fields, empty string when not given. */
const DETAIL_FIELDS = [
  'title',
  'gender',
  'passportCountry',
  'passportIssuedOn',
  'passportExpiresOn',
  'placeOfBirth',
  'visaType',
  'arrivalDate',
  'arrivalFlight',
  'arrivalPort',
  'phone',
  'emergencyName',
  'emergencyPhone',
  'allergies',
  'occasion',
  'occasionDate',
] as const;
type DetailField = (typeof DETAIL_FIELDS)[number];
const DIETARY = [
  'vegetarian',
  'vegan',
  'halal',
  'kosher',
  'gluten_free',
  'lactose_free',
  'no_pork',
  'no_seafood',
  'diabetic',
] as const;

interface Guest extends Record<DetailField, string | null> {
  id: string;
  cabin: number;
  firstName: string;
  lastName: string;
  nationality: string | null;
  dateOfBirth: string | null;
  hasPassport: boolean;
  lead: boolean;
  hasVisaNumber: boolean;
  hasMedicalNotes: boolean;
  dietary: string[];
}
interface Draft extends Record<DetailField, string> {
  key: string;
  keepPassportOf?: string;
  hasPassport: boolean;
  hasVisaNumber: boolean;
  hasMedicalNotes: boolean;
  cabin: number;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string;
  passportNumber: string;
  visaNumber: string;
  medicalNotes: string;
  dietary: string[];
  lead: boolean;
}

const emptyDetails = () =>
  Object.fromEntries(DETAIL_FIELDS.map((f) => [f, ''])) as Record<DetailField, string>;

const toDraft = (g: Guest): Draft => ({
  key: g.id,
  // Keeps the passport, visa number and medical notes on file unless new ones are typed.
  keepPassportOf: g.hasPassport || g.hasVisaNumber || g.hasMedicalNotes ? g.id : undefined,
  hasPassport: g.hasPassport,
  hasVisaNumber: g.hasVisaNumber,
  hasMedicalNotes: g.hasMedicalNotes,
  cabin: g.cabin,
  firstName: g.firstName,
  lastName: g.lastName,
  nationality: g.nationality ?? '',
  dateOfBirth: g.dateOfBirth ?? '',
  passportNumber: '',
  visaNumber: '',
  medicalNotes: '',
  dietary: g.dietary,
  lead: g.lead,
  ...(Object.fromEntries(DETAIL_FIELDS.map((f) => [f, g[f] ?? ''])) as Record<DetailField, string>),
});

/** Passport numbers are write-only here: staff see "on file", never the number. */
export function GuestsEditor({
  bookingId,
  canEdit,
  canPrivacy = false,
  cabins,
  guests,
}: {
  bookingId: string;
  canEdit: boolean;
  canPrivacy?: boolean;
  cabins: number[];
  guests: Guest[];
}) {
  const t = useTranslations('bookings');
  const tb = useTranslations('book');
  const tc = useTranslations('common');
  const tg = useTranslations('guestDetails');
  const locale = useLocale();
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>(() => guests.map(toDraft));
  const requestKey = useMemo(() => newRequestKey(), [drafts]);
  const save = useMutation(
    trpc.bookings.guests.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        router.refresh();
      },
    }),
  );
  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts(
      drafts.map((d, j) => (j === i ? { ...d, ...patch } : patch.lead ? { ...d, lead: false } : d)),
    );

  if (!editing) {
    return (
      <>
        {guests.length === 0 ? (
          <p className="text-sm text-muted">{tc('none')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {guests.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="text-muted">
                  {t('cabin')} {g.cabin + 1}
                </span>
                <span className="font-medium">
                  {g.firstName} {g.lastName}
                </span>
                {g.lead && <Badge tone="info">{t('lead')}</Badge>}
                {g.nationality && (
                  <span className="text-muted">
                    <CountryName code={g.nationality} locale={locale} />
                  </span>
                )}
                {g.dateOfBirth && (
                  <span className="text-muted">{formatDate(g.dateOfBirth, locale, 'long')}</span>
                )}
                <Badge tone={g.hasPassport ? 'ok' : 'warn'}>
                  {g.hasPassport ? t('passportOnFile') : t('noPassport')}
                </Badge>
                {g.dietary.map((d) => (
                  <Badge key={d} tone="info">
                    {tg(`dietary_${d}`)}
                  </Badge>
                ))}
                {g.occasion && <Badge tone="brand">{tg(`occasion_${g.occasion}`)}</Badge>}
                {canPrivacy && (
                  <PrivacyActions guestId={g.id} name={`${g.firstName} ${g.lastName}`} />
                )}
              </li>
            ))}
          </ul>
        )}
        {canEdit && (
          <Button
            variant="secondary"
            className="mt-3"
            onClick={() => {
              setDrafts(guests.map(toDraft));
              setEditing(true);
            }}
          >
            {t('editGuests')}
          </Button>
        )}
      </>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({
          bookingId,
          requestKey,
          guests: drafts.map((d) => ({
            cabin: d.cabin,
            firstName: d.firstName,
            lastName: d.lastName,
            nationality: d.nationality ? d.nationality.toUpperCase() : undefined,
            dateOfBirth: d.dateOfBirth || undefined,
            passportNumber: d.passportNumber.trim() || undefined,
            keepPassportOf: d.keepPassportOf,
            lead: d.lead,
            ...(Object.fromEntries(
              DETAIL_FIELDS.map((f) => [f, d[f].trim() || undefined]),
            ) as Record<DetailField, never>),
            passportCountry: d.passportCountry ? d.passportCountry.toUpperCase() : undefined,
            visaNumber: d.visaNumber.trim() || undefined,
            medicalNotes: d.medicalNotes.trim() || undefined,
            dietary: d.dietary as (typeof DIETARY)[number][],
          })),
        });
      }}
    >
      {drafts.map((d, i) => (
        <fieldset
          key={d.key}
          className="grid grid-cols-2 gap-2 rounded-lg border border-line p-3 sm:grid-cols-4"
        >
          <Field label={t('cabin')}>
            <Select value={d.cabin} onChange={(e) => update(i, { cabin: Number(e.target.value) })}>
              {cabins.map((c) => (
                <option key={c} value={c}>
                  {c + 1}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={tb('firstName')}>
            <Input
              required
              value={d.firstName}
              onChange={(e) => update(i, { firstName: e.target.value })}
            />
          </Field>
          <Field label={tb('lastName')}>
            <Input
              required
              value={d.lastName}
              onChange={(e) => update(i, { lastName: e.target.value })}
            />
          </Field>
          <Field label={tb('nationality')}>
            <CountrySelect
              value={d.nationality}
              onChange={(nationality) => update(i, { nationality })}
            />
          </Field>
          <Field label={t('dob')}>
            <Input
              type="date"
              value={d.dateOfBirth}
              onChange={(e) => update(i, { dateOfBirth: e.target.value })}
            />
          </Field>
          <Field label={d.hasPassport ? t('passportOnFile') : t('noPassport')}>
            <Input
              dir="ltr"
              autoComplete="off"
              placeholder={d.hasPassport ? '••••••' : ''}
              value={d.passportNumber}
              onChange={(e) => update(i, { passportNumber: e.target.value })}
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="radio"
              name="lead"
              checked={d.lead}
              onChange={() => update(i, { lead: true })}
            />
            {t('lead')}
          </label>
          <CheckinDetails draft={d} onChange={(patch) => update(i, patch)} />
          <div className="flex items-end justify-end">
            {drafts.length > 1 && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
              >
                {tb('removeCabin')}
              </Button>
            )}
          </div>
        </fieldset>
      ))}
      {save.isError && <Alert tone="bad">{errorText(save.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            setDrafts([
              ...drafts,
              {
                key: newRequestKey(),
                hasPassport: false,
                hasVisaNumber: false,
                hasMedicalNotes: false,
                cabin: drafts.at(-1)?.cabin ?? 0,
                firstName: '',
                lastName: '',
                nationality: '',
                dateOfBirth: '',
                passportNumber: '',
                visaNumber: '',
                medicalNotes: '',
                dietary: [],
                lead: drafts.length === 0,
                ...emptyDetails(),
              },
            ])
          }
        >
          + {t('addGuest')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t('saveGuests')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}

/**
 * The optional check-in details, folded away: the reception and the police list need them, most
 * bookings fill them in later. Visa numbers and medical notes are write-only, like passports.
 */
function CheckinDetails({
  draft: d,
  onChange,
}: {
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const tg = useTranslations('guestDetails');
  const text = (field: DetailField, type: 'text' | 'date' | 'tel' = 'text') => (
    <Field label={tg(field)}>
      <Input
        type={type}
        dir={type === 'tel' || field === 'arrivalFlight' ? 'ltr' : undefined}
        value={d[field]}
        onChange={(e) => onChange({ [field]: e.target.value })}
      />
    </Field>
  );
  const choice = (field: DetailField, options: readonly string[], prefix: string) => (
    <Field label={tg(field)}>
      <Select value={d[field]} onChange={(e) => onChange({ [field]: e.target.value })}>
        <option value="">{tg('none')}</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {tg(`${prefix}${o}`)}
          </option>
        ))}
      </Select>
    </Field>
  );
  return (
    <details className="col-span-full rounded-lg bg-line/20 px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">{tg('section')}</summary>
      <p className="mt-1 mb-2 text-xs text-muted">{tg('sectionHelp')}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {choice('title', ['mr', 'mrs', 'ms', 'miss', 'dr'], 'title_')}
        {choice('gender', ['female', 'male'], '')}
        <Field label={tg('passportCountry')}>
          <CountrySelect
            value={d.passportCountry}
            onChange={(passportCountry) => onChange({ passportCountry })}
          />
        </Field>
        {text('placeOfBirth')}
        {text('passportIssuedOn', 'date')}
        {text('passportExpiresOn', 'date')}
        {choice(
          'visaType',
          ['e_visa', 'on_arrival', 'sticker', 'residence', 'not_required'],
          'visa_',
        )}
        <Field label={d.hasVisaNumber ? tg('onFile') : tg('visaNumber')}>
          <Input
            dir="ltr"
            autoComplete="off"
            placeholder={d.hasVisaNumber ? '••••••' : ''}
            value={d.visaNumber}
            onChange={(e) => onChange({ visaNumber: e.target.value })}
          />
        </Field>
        {text('arrivalDate', 'date')}
        {text('arrivalFlight')}
        {text('arrivalPort')}
        {text('phone', 'tel')}
        {text('emergencyName')}
        {text('emergencyPhone', 'tel')}
        {choice('occasion', ['birthday', 'honeymoon', 'anniversary', 'other'], 'occasion_')}
        {text('occasionDate', 'date')}
      </div>
      <fieldset className="mt-2">
        <legend className="mb-1 text-sm">{tg('dietary')}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {DIETARY.map((diet) => (
            <label key={diet} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={d.dietary.includes(diet)}
                onChange={(e) =>
                  onChange({
                    dietary: e.target.checked
                      ? [...d.dietary, diet]
                      : d.dietary.filter((x) => x !== diet),
                  })
                }
              />
              {tg(`dietary_${diet}`)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {text('allergies')}
        <Field
          label={d.hasMedicalNotes ? `${tg('medicalNotes')} · ${tg('onFile')}` : tg('medicalNotes')}
        >
          <Input
            autoComplete="off"
            placeholder={d.hasMedicalNotes ? '••••••' : ''}
            value={d.medicalNotes}
            onChange={(e) => onChange({ medicalNotes: e.target.value })}
          />
        </Field>
      </div>
    </details>
  );
}

/** Owner only: a data subject's export (JSON file) or erasure. */
function PrivacyActions({ guestId, name }: { guestId: string; name: string }) {
  const t = useTranslations('bookings');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const router = useRouter();
  const errorText = useErrorText();
  const [confirming, setConfirming] = useState(false);
  const exportData = useMutation(
    trpc.bookings.exportGuest.mutationOptions({
      onSuccess: (data) => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `guest-${guestId}.json`;
        link.click();
        URL.revokeObjectURL(url);
      },
    }),
  );
  const erase = useMutation(
    trpc.bookings.eraseGuest.mutationOptions({
      onSuccess: () => {
        setConfirming(false);
        router.refresh();
      },
    }),
  );
  return (
    <span className="ms-auto flex gap-1">
      <Button
        variant="ghost"
        disabled={exportData.isPending}
        onClick={() => exportData.mutate({ guestId })}
      >
        {t('exportData')}
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        {t('erase')}
      </Button>
      <Dialog open={confirming} onClose={() => setConfirming(false)} title={t('eraseTitle')}>
        <p className="mb-2 font-medium">{name}</p>
        <Alert tone="warn">{t('eraseHelp')}</Alert>
        {(erase.isError || exportData.isError) && (
          <Alert tone="bad">{errorText(erase.error ?? exportData.error)}</Alert>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)}>
            {tc('close')}
          </Button>
          <Button
            variant="danger"
            disabled={erase.isPending}
            onClick={() => erase.mutate({ guestId })}
          >
            {t('erase')}
          </Button>
        </div>
      </Dialog>
    </span>
  );
}
