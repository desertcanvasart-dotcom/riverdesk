'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input, Select } from './ui';

export interface Choice {
  value: string;
  label: string;
}

const OTHER = '__other__';

/**
 * Pick a common answer from a list, or choose "Other…" and type one. Works controlled (`value` +
 * `onChange`) or inside a plain form (`name` + `defaultValue`: a hidden input carries the value).
 * A value that is not in the list (typed earlier) shows as "Other" with its text.
 */
export function ChoiceField({
  choices,
  name,
  value,
  defaultValue = '',
  onChange,
  required = false,
  allowEmpty = true,
  maxLength = 100,
  dir,
}: {
  choices: Choice[];
  name?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  required?: boolean;
  /** Offer "—" for "none" (optional fields). */
  allowEmpty?: boolean;
  maxLength?: number;
  dir?: 'ltr' | 'rtl';
}) {
  const t = useTranslations('choices');
  const [own, setOwn] = useState(defaultValue);
  const current = value ?? own;
  const known = choices.some((c) => c.value === current);
  const [other, setOther] = useState(!known && current !== '');
  const set = (next: string) => {
    if (value === undefined) setOwn(next);
    onChange?.(next);
  };
  return (
    <div className="flex flex-col gap-2">
      <Select
        value={other ? OTHER : current}
        required={required && !other}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setOther(true);
            set('');
          } else {
            setOther(false);
            set(e.target.value);
          }
        }}
      >
        {(allowEmpty || current === '') && !other && (
          <option value="">{allowEmpty ? t('none') : t('choose')}</option>
        )}
        {choices.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
        <option value={OTHER}>{t('other')}</option>
      </Select>
      {other && (
        <Input
          autoFocus
          required={required}
          maxLength={maxLength}
          dir={dir}
          placeholder={t('typeIt')}
          value={current}
          onChange={(e) => set(e.target.value)}
        />
      )}
      {name && <input type="hidden" name={name} value={current} />}
    </div>
  );
}
