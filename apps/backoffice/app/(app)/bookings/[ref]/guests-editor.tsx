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
import { CountrySelect, countryName } from '../../../../components/country-select';

interface Guest {
  id: string;
  cabin: number;
  firstName: string;
  lastName: string;
  nationality: string | null;
  dateOfBirth: string | null;
  hasPassport: boolean;
  lead: boolean;
}
interface Draft {
  key: string;
  keepPassportOf?: string;
  hasPassport: boolean;
  cabin: number;
  firstName: string;
  lastName: string;
  nationality: string;
  dateOfBirth: string;
  passportNumber: string;
  lead: boolean;
}

const toDraft = (g: Guest): Draft => ({
  key: g.id,
  keepPassportOf: g.hasPassport ? g.id : undefined,
  hasPassport: g.hasPassport,
  cabin: g.cabin,
  firstName: g.firstName,
  lastName: g.lastName,
  nationality: g.nationality ?? '',
  dateOfBirth: g.dateOfBirth ?? '',
  passportNumber: '',
  lead: g.lead,
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
                  <span className="text-muted">{countryName(g.nationality, locale)}</span>
                )}
                {g.dateOfBirth && (
                  <span className="text-muted">{formatDate(g.dateOfBirth, locale, 'long')}</span>
                )}
                <Badge tone={g.hasPassport ? 'ok' : 'warn'}>
                  {g.hasPassport ? t('passportOnFile') : t('noPassport')}
                </Badge>
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
                cabin: drafts.at(-1)?.cabin ?? 0,
                firstName: '',
                lastName: '',
                nationality: '',
                dateOfBirth: '',
                passportNumber: '',
                lead: drafts.length === 0,
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
