'use client';

import { useTranslations } from 'next-intl';
import { addDaysIso } from '../lib/dates';
import { Button, Input } from './ui';

/** A date window with earlier / later buttons. */
export function RangeNav({
  from,
  days,
  onChange,
}: {
  from: string;
  days: number;
  onChange: (from: string) => void;
}) {
  const t = useTranslations('book');
  return (
    <div className="flex items-center gap-1">
      <Button type="button" variant="ghost" onClick={() => onChange(addDaysIso(from, -days))}>
        {t('earlier')}
      </Button>
      <Input
        type="date"
        value={from}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="w-40"
        aria-label={t('dates')}
      />
      <Button type="button" variant="ghost" onClick={() => onChange(addDaysIso(from, days))}>
        {t('later')}
      </Button>
    </div>
  );
}

export function VesselSelect({
  vessels,
  value,
  onChange,
}: {
  vessels: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  if (vessels.length < 2) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-10 rounded-lg border border-line bg-surface px-3 text-sm"
    >
      {vessels.map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
    </select>
  );
}
