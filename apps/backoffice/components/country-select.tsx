'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { Select } from './ui';

/** Where Nile cruise guests most often come from: listed first. */
const FIRST = ['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'GB', 'DE', 'FR', 'IT', 'ES', 'US'];

// ISO 3166-1 alpha-2 (the guest record stores this code).
const ALL =
  'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PS PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW'.split(
    ' ',
  );

/** A country's name in the screen's language (the code when the browser does not know it). */
export function countryName(code: string, locale: string): string {
  try {
    return (
      new Intl.DisplayNames([locale.startsWith('ar') ? 'ar' : 'en'], { type: 'region' }).of(code) ??
      code
    );
  } catch {
    return code;
  }
}

/** Country picker for nationalities: names in the screen's language, value the 2-letter code. */
export function CountrySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (code: string) => void;
}) {
  const t = useTranslations('choices');
  const locale = useLocale();
  const { first, rest } = useMemo(() => {
    const names = new Intl.DisplayNames([locale.startsWith('ar') ? 'ar' : 'en'], {
      type: 'region',
    });
    const name = (code: string) => names.of(code) ?? code;
    const collator = new Intl.Collator(locale);
    return {
      first: FIRST.map((code) => ({ code, name: name(code) })),
      rest: ALL.filter((c) => !FIRST.includes(c))
        .map((code) => ({ code, name: name(code) }))
        .sort((a, b) => collator.compare(a.name, b.name)),
    };
  }, [locale]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{t('none')}</option>
      <optgroup label={t('commonCountries')}>
        {first.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </optgroup>
      <optgroup label={t('allCountries')}>
        {rest.map((c) => (
          <option key={c.code} value={c.code}>
            {c.name}
          </option>
        ))}
      </optgroup>
    </Select>
  );
}
