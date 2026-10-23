'use client';

import { useTranslations } from 'next-intl';

interface Line {
  kind: string;
  label: string;
  basis?: string;
  age?: number;
}

/** Price lines in the reader's language; supplements keep the name the operator gave them. */
export function usePriceLineLabel() {
  const t = useTranslations();
  const basis = (b?: string) => (b && t.has(`basis.${b}`) ? t(`basis.${b}`) : (b ?? ''));
  return (line: Line): string => {
    switch (line.kind) {
      case 'adult':
        return t('line.adult', { basis: basis(line.basis) });
      case 'child':
        return line.basis === 'child_as_adult'
          ? t('line.childAsAdult', { age: line.age ?? 0 })
          : t('line.child', { age: line.age ?? 0, basis: basis(line.basis) });
      case 'cabin':
        return t('line.cabin', { code: line.label.replace(/^Cabin /, '') });
      case 'markup':
      case 'commission':
        return t(`line.${line.kind}`);
      default:
        return line.label;
    }
  };
}
