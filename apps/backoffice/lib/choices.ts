'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { Choice } from '../components/choice-field';

/**
 * Common answers for fields people used to type. Deck, view and beds are stored in English (as
 * agencies and vouchers read them) and shown in the screen's language; reasons are stored as the
 * words staff picked.
 */

const DECKS = {
  lower: 'Lower',
  main: 'Main',
  middle: 'Middle',
  upper: 'Upper',
  promenade: 'Promenade',
  sun: 'Sun',
};
const VIEWS = {
  river: 'River view',
  panoramic: 'Panoramic',
  balcony: 'Private balcony',
  french: 'French balcony',
  window: 'Window',
  porthole: 'Porthole',
};
const BEDS = {
  twin: 'Twin',
  double: 'Double',
  twinOrDouble: 'Twin or double',
  king: 'King',
  triple: 'Triple',
  twinSofa: 'Twin + sofa bed',
};

type ChoiceSet = 'deck' | 'view' | 'bed';
const SETS: Record<ChoiceSet, Record<string, string>> = { deck: DECKS, view: VIEWS, bed: BEDS };

/** Choices for one set, plus any `extra` values already in use (e.g. a ship's own deck names). */
export function useChoices(set: ChoiceSet, extra: (string | null | undefined)[] = []): Choice[] {
  const t = useTranslations(`choices.${set}`);
  const known = Object.entries(SETS[set]).map(([key, value]) => ({ value, label: t(key) }));
  const more = [...new Set(extra.filter((v): v is string => Boolean(v)))]
    .filter((v) => !known.some((k) => k.value === v))
    .map((v) => ({ value: v, label: v }));
  return [...known, ...more];
}

/** A stored deck, view or beds value in the screen's language (as typed when it is not ours). */
export function useChoiceLabel() {
  const t = useTranslations('choices');
  return (set: ChoiceSet, value: string | null | undefined) => {
    if (!value) return '';
    const key = Object.entries(SETS[set]).find(([, v]) => v === value)?.[0];
    return key ? t(`${set}.${key}`) : value;
  };
}

type ReasonKind = 'block' | 'capacity' | 'schedule' | 'cancel' | 'decline' | 'reversal';
const REASONS: Record<ReasonKind, string[]> = {
  block: ['maintenance', 'group', 'crew', 'vip', 'complaint'],
  capacity: ['initialSetup', 'refit', 'newCabins', 'retired', 'reclassified'],
  schedule: ['lowWater', 'lock', 'weather', 'technical', 'charter', 'lowDemand', 'authorities'],
  cancel: ['guestRequest', 'agencyRequest', 'unpaid', 'duplicate', 'sailingCancelled', 'medical'],
  decline: ['full', 'priceNotAccepted', 'datesUnavailable', 'groupTooLarge'],
  reversal: ['wrongAmount', 'wrongBooking', 'bounced', 'duplicatePayment'],
};

/** Usual reasons, in the screen's language: what staff pick is stored as written. */
export function useReasons(kind: ReasonKind): Choice[] {
  const t = useTranslations(`choices.reasons.${kind}`);
  return REASONS[kind].map((key) => ({ value: t(key), label: t(key) }));
}

/** Nile ports a company may add in one click (code, English, Arabic). */
export const NILE_PORTS = [
  ['LXR', 'Luxor', 'الأقصر'],
  ['ESN', 'Esna', 'إسنا'],
  ['EDF', 'Edfu', 'إدفو'],
  ['KOM', 'Kom Ombo', 'كوم أمبو'],
  ['ASW', 'Aswan', 'أسوان'],
  ['DEN', 'Dendera', 'دندرة'],
  ['QEN', 'Qena', 'قنا'],
  ['ABY', 'Abydos', 'أبيدوس'],
  ['NAG', 'Nag Hammadi', 'نجع حمادي'],
  ['SHG', 'Sohag', 'سوهاج'],
  ['AST', 'Asyut', 'أسيوط'],
  ['MNY', 'Minya', 'المنيا'],
  ['BSF', 'Beni Suef', 'بني سويف'],
  ['CAI', 'Cairo', 'القاهرة'],
  ['ABS', 'Abu Simbel', 'أبو سمبل'],
  ['KAL', 'Kalabsha', 'كلابشة'],
  ['WSB', 'Wadi El Seboua', 'وادي السبوع'],
  ['AMD', 'Amada', 'عمدا'],
  ['QIB', 'Qasr Ibrim', 'قصر إبريم'],
] as const;

/** Common markets (code, English, Arabic, needs proof of residency or ID). */
export const COMMON_MARKETS = [
  ['gcc', 'Gulf (GCC)', 'دول الخليج', true],
  ['arab', 'Arab nationals', 'الجنسيات العربية', true],
  ['european', 'European', 'أوروبي', false],
  ['north_american', 'North American', 'أمريكا الشمالية', false],
  ['asian', 'Asian', 'آسيوي', false],
  ['latin_american', 'Latin American', 'أمريكا اللاتينية', false],
  ['african', 'African', 'أفريقي', true],
  ['egyptian_national', 'Egyptian nationals', 'المواطنون المصريون', true],
] as const;

/** Usual season names (code, English, Arabic). */
export const COMMON_SEASONS = [
  ['HIGH', 'High season', 'الموسم المرتفع'],
  ['LOW', 'Low season', 'الموسم المنخفض'],
  ['SHOULDER', 'Shoulder season', 'الموسم المتوسط'],
  ['PEAK', 'Peak season', 'ذروة الموسم'],
  ['XMAS', 'Christmas and New Year', 'الكريسماس ورأس السنة'],
  ['EASTER', 'Easter', 'عيد الفصح'],
  ['EID', 'Eid holidays', 'إجازات العيد'],
  ['SUMMER', 'Summer', 'الصيف'],
] as const;

/** Pick the English or Arabic name of a [code, en, ar, …] row. */
export function usePickName() {
  const locale = useLocale();
  return (row: readonly [string, string, string, ...unknown[]]) =>
    locale.startsWith('ar') ? row[2] : row[1];
}
