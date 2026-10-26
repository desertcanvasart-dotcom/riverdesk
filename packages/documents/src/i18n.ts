import { decimalsOf, minorToDecimal } from '@vs/shared';

/** Document wording in both languages, and locale-aware formatting (integer minor units in). */

export type Locale = 'ar' | 'en';
/** A document's language: Arabic, English, or both (Arabic first, English beneath each label). */
export type DocLocale = Locale | 'both';

const en = {
  voucher: 'Voucher',
  itinerary: 'Itinerary',
  payment_schedule: 'Payment schedule and receipts',
  cancellation_terms: 'Cancellation terms',
  manifest: 'Passenger manifest',
  rooming_list: 'Rooming list',
  vacancy_sheet: 'Vacancy sheet',
  outage_pack: 'Outage pack: availability and departures (14 days)',
  bookingRef: 'Booking reference',
  agencyRef: 'Agency reference',
  bookedBy: 'Booked through',
  vessel: 'Vessel',
  cruise: 'Cruise',
  embark: 'Embarkation',
  disembark: 'Disembarkation',
  nights: 'Nights',
  cabins: 'Cabins',
  cabin: 'Cabin',
  category: 'Category',
  guests: 'Guests',
  lead: 'lead guest',
  adults: 'Adults',
  children: 'Children (ages)',
  inclusions: 'Included',
  exclusions: 'Not included',
  board: 'Board',
  full_board: 'Full board',
  half_board: 'Half board',
  bed_breakfast: 'Bed and breakfast',
  total: 'Total',
  fees: 'Fees',
  paid: 'Paid',
  balance: 'Balance',
  due: 'Due by',
  dueNow: 'Payments due',
  received: 'Payments received',
  noPayments: 'No payments yet.',
  receivedOn: 'Date',
  method: 'Method',
  reference: 'Reference',
  amount: 'Amount',
  deposit: 'Deposit',
  balanceKind: 'Balance',
  payment: 'Payment',
  refund: 'Refund',
  bank_transfer: 'Bank transfer',
  cash: 'Cash',
  card_office: 'Card (office)',
  agent_remittance: 'Agent remittance',
  channel: 'Collected by channel',
  gateway: 'Online gateway',
  cancellationIntro:
    'If the booking is cancelled, this share of the total is kept, by how many days before embarkation the cancellation is received (Cairo date):',
  daysOrMore: '{n} days or more',
  lessThan: 'Less than {n} days',
  penalty: '{p}% of the total',
  emergency: 'Emergency contact',
  residencyNote:
    'This booking uses a resident or Egyptian rate: every guest must show a valid residency permit or Egyptian ID at embarkation.',
  issued: 'Issued',
  day: 'Day {n}',
  sailFrom: '{from} to {to}',
  nationality: 'Nationality',
  dob: 'Date of birth',
  passport: 'Passport',
  name: 'Name',
  notAssigned: 'To be assigned',
  departure: 'Departure',
  ports: 'Ports of call',
  date: 'Date',
  from: 'From',
  to: 'To',
  free: 'Free cabins',
  booking: 'Booking',
  totalGuests: '{n} guests',
  confidential: 'Contains passport data. Keep confidential and delete after use.',
  agencyCopy: 'Agency copy (no prices)',
  tel: 'Tel',
  whatsapp: 'WhatsApp',
  embarkation_sheet: 'Embarkation sheet',
  checkin_file: 'Guest details for check-in',
  registration_cards: 'Guest registration cards',
  boarding: 'Boarding',
  cabinsN: '{n} cabins',
  checkedIn: 'Checked in',
  passportsSeen: 'Passports seen',
  cardSigned: 'Card signed',
  keyHanded: 'Key handed',
  toCollect: 'To collect',
  arrival: 'Arrival',
  notes: 'Notes',
  dietaryTitle: 'Special diets',
  occasionsTitle: 'Special occasions',
  nationalitiesTitle: 'Nationalities',
  receptionist: 'Receptionist',
  signature: 'Signature',
  warningsTitle: 'To check at the desk',
  no_passport: 'No passport number on file',
  passport_expiring: 'Passport expires within 6 months of the cruise',
  passport_expired: 'Passport has expired',
  title: 'Title',
  gender: 'Gender',
  passportCountry: 'Passport issued by',
  passportIssuedOn: 'Passport issued',
  passportExpiresOn: 'Passport expires',
  placeOfBirth: 'Place of birth',
  visa: 'Visa',
  visaNumber: 'Visa number',
  phone: 'Phone',
  emergencyContact: 'Emergency contact',
  allergies: 'Allergies',
  medical: 'Medical or mobility',
  occasion: 'Occasion',
  flight: 'Flight',
  entryPort: 'Port of entry',
  female: 'Female',
  male: 'Male',
  mr: 'Mr',
  mrs: 'Mrs',
  ms: 'Ms',
  miss: 'Miss',
  dr: 'Dr',
  e_visa: 'e-Visa',
  on_arrival: 'Visa on arrival',
  sticker: 'Visa sticker',
  residence: 'Residence permit',
  not_required: 'Not required',
  vegetarian: 'Vegetarian',
  vegan: 'Vegan',
  halal: 'Halal',
  kosher: 'Kosher',
  gluten_free: 'Gluten-free',
  lactose_free: 'Lactose-free',
  no_pork: 'No pork',
  no_seafood: 'No seafood',
  diabetic: 'Diabetic',
  birthday: 'Birthday',
  honeymoon: 'Honeymoon',
  anniversary: 'Anniversary',
  otherOccasion: 'Other',
  cardTitle: 'Guest registration card',
  declaration: 'I confirm that the details above are correct.',
  guestSignature: 'Guest signature',
  lastName: 'Last name',
  firstName: 'First name',
  none: 'None',
  departs: 'Departs',
  allCheckedIn: '{done} of {n} cabins checked in',
};

const ar: typeof en = {
  voucher: 'قسيمة الحجز',
  itinerary: 'برنامج الرحلة',
  payment_schedule: 'جدول الدفع والإيصالات',
  cancellation_terms: 'شروط الإلغاء',
  manifest: 'كشف الركاب',
  rooming_list: 'كشف توزيع الكبائن',
  vacancy_sheet: 'كشف الأماكن المتاحة',
  outage_pack: 'حزمة الطوارئ: المتاح والرحلات (١٤ يومًا)',
  bookingRef: 'مرجع الحجز',
  agencyRef: 'مرجع الوكالة',
  bookedBy: 'الحجز عن طريق',
  vessel: 'المركب',
  cruise: 'الرحلة',
  embark: 'الصعود',
  disembark: 'النزول',
  nights: 'الليالي',
  cabins: 'الكبائن',
  cabin: 'الكابينة',
  category: 'الفئة',
  guests: 'الضيوف',
  lead: 'الضيف الرئيسي',
  adults: 'البالغون',
  children: 'الأطفال (الأعمار)',
  inclusions: 'يشمل',
  exclusions: 'لا يشمل',
  board: 'الإقامة',
  full_board: 'إقامة كاملة',
  half_board: 'نصف إقامة',
  bed_breakfast: 'مبيت وإفطار',
  total: 'الإجمالي',
  fees: 'الرسوم',
  paid: 'المدفوع',
  balance: 'المتبقي',
  due: 'مستحق في',
  dueNow: 'المدفوعات المستحقة',
  received: 'المدفوعات المستلمة',
  noPayments: 'لا توجد مدفوعات بعد.',
  receivedOn: 'التاريخ',
  method: 'الطريقة',
  reference: 'المرجع',
  amount: 'المبلغ',
  deposit: 'عربون',
  balanceKind: 'المتبقي',
  payment: 'دفعة',
  refund: 'استرداد',
  bank_transfer: 'تحويل بنكي',
  cash: 'نقدًا',
  card_office: 'بطاقة (المكتب)',
  agent_remittance: 'تحويل من الوكيل',
  channel: 'حصّلته القناة',
  gateway: 'بوابة دفع إلكتروني',
  cancellationIntro:
    'عند إلغاء الحجز يُحتفظ بالنسبة التالية من الإجمالي، حسب عدد الأيام قبل الصعود التي يصل فيها الإلغاء (بتوقيت القاهرة):',
  daysOrMore: '{n} يومًا أو أكثر',
  lessThan: 'أقل من {n} يومًا',
  penalty: '{p}% من الإجمالي',
  emergency: 'رقم الطوارئ',
  residencyNote:
    'هذا الحجز بسعر المقيمين أو المصريين: يجب على كل ضيف إبراز إقامة سارية أو بطاقة رقم قومي مصرية عند الصعود.',
  issued: 'تاريخ الإصدار',
  day: 'اليوم {n}',
  sailFrom: 'من {from} إلى {to}',
  nationality: 'الجنسية',
  dob: 'تاريخ الميلاد',
  passport: 'جواز السفر',
  name: 'الاسم',
  notAssigned: 'يُحدد لاحقًا',
  departure: 'المغادرة',
  ports: 'المحطات',
  date: 'التاريخ',
  from: 'من',
  to: 'إلى',
  free: 'الكبائن المتاحة',
  booking: 'الحجز',
  totalGuests: '{n} ضيف',
  confidential: 'يحتوي على بيانات جوازات السفر. سرّي، يُحذف بعد الاستخدام.',
  agencyCopy: 'نسخة الوكالة (بدون أسعار)',
  tel: 'هاتف',
  whatsapp: 'واتساب',
  embarkation_sheet: 'كشف الصعود',
  checkin_file: 'كشف بيانات الضيوف للتسجيل',
  registration_cards: 'بطاقات تسجيل الضيوف',
  boarding: 'الصعود',
  cabinsN: '{n} كابينة',
  checkedIn: 'تم التسجيل',
  passportsSeen: 'مطابقة الجوازات',
  cardSigned: 'توقيع البطاقة',
  keyHanded: 'تسليم المفتاح',
  toCollect: 'مطلوب تحصيله',
  arrival: 'الوصول',
  notes: 'ملاحظات',
  dietaryTitle: 'الأنظمة الغذائية الخاصة',
  occasionsTitle: 'المناسبات الخاصة',
  nationalitiesTitle: 'الجنسيات',
  receptionist: 'موظف الاستقبال',
  signature: 'التوقيع',
  warningsTitle: 'للمراجعة عند الاستقبال',
  no_passport: 'لا يوجد رقم جواز سفر مسجّل',
  passport_expiring: 'ينتهي الجواز خلال ٦ أشهر من الرحلة',
  passport_expired: 'الجواز منتهي الصلاحية',
  title: 'اللقب',
  gender: 'النوع',
  passportCountry: 'جهة إصدار الجواز',
  passportIssuedOn: 'تاريخ إصدار الجواز',
  passportExpiresOn: 'تاريخ انتهاء الجواز',
  placeOfBirth: 'محل الميلاد',
  visa: 'التأشيرة',
  visaNumber: 'رقم التأشيرة',
  phone: 'الهاتف',
  emergencyContact: 'جهة الاتصال في الطوارئ',
  allergies: 'الحساسية',
  medical: 'ملاحظات طبية أو حركية',
  occasion: 'المناسبة',
  flight: 'رقم الرحلة الجوية',
  entryPort: 'منفذ الدخول',
  female: 'أنثى',
  male: 'ذكر',
  mr: 'السيد',
  mrs: 'السيدة',
  ms: 'السيدة',
  miss: 'الآنسة',
  dr: 'د.',
  e_visa: 'تأشيرة إلكترونية',
  on_arrival: 'تأشيرة عند الوصول',
  sticker: 'تأشيرة ملصقة',
  residence: 'إقامة',
  not_required: 'غير مطلوبة',
  vegetarian: 'نباتي',
  vegan: 'نباتي صرف',
  halal: 'حلال',
  kosher: 'كوشر',
  gluten_free: 'خالٍ من الغلوتين',
  lactose_free: 'خالٍ من اللاكتوز',
  no_pork: 'بدون لحم خنزير',
  no_seafood: 'بدون مأكولات بحرية',
  diabetic: 'مريض سكري',
  birthday: 'عيد ميلاد',
  honeymoon: 'شهر العسل',
  anniversary: 'ذكرى الزواج',
  otherOccasion: 'مناسبة أخرى',
  cardTitle: 'بطاقة تسجيل ضيف',
  declaration: 'أُقرّ بصحة البيانات المذكورة أعلاه.',
  guestSignature: 'توقيع الضيف',
  lastName: 'اسم العائلة',
  firstName: 'الاسم الأول',
  none: 'لا يوجد',
  departs: 'موعد الإبحار',
  allCheckedIn: 'تم تسجيل {done} من {n} كابينة',
};

export type Key = keyof typeof en;

function fill(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}

const lookup = (dict: typeof en, key: string) => (dict as Record<string, string>)[key] ?? key;

/**
 * Wording for HTML documents. Values are inserted as given (callers escape data). In a bilingual
 * document each label is the Arabic text with the English beneath it.
 */
export function translator(locale: DocLocale) {
  return (key: Key | string, values: Record<string, string | number> = {}) => {
    if (locale !== 'both') return fill(lookup(locale === 'ar' ? ar : en, key), values);
    const a = fill(lookup(ar, key), values);
    const b = fill(lookup(en, key), values);
    return a === b ? a : `<span class="bi">${a}<span class="en" dir="ltr">${b}</span></span>`;
  };
}

/** Plain-text wording (spreadsheets, file and page titles): "عربي / English" when bilingual. */
export function textTranslator(locale: DocLocale) {
  return (key: Key | string, values: Record<string, string | number> = {}) => {
    if (locale !== 'both') return fill(lookup(locale === 'ar' ? ar : en, key), values);
    const a = fill(lookup(ar, key), values);
    const b = fill(lookup(en, key), values);
    return a === b ? a : `${a} / ${b}`;
  };
}

/** Bilingual documents use Latin digits, which both readers share. */
const tag = (locale: DocLocale) => (locale === 'ar' ? 'ar-EG' : 'en-GB');

export function money(amount: bigint, currency: string, locale: DocLocale): string {
  const digits = decimalsOf(currency);
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(minorToDecimal(amount, currency) as unknown as number);
}

export function date(value: string, locale: DocLocale, style: 'short' | 'long' = 'long'): string {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag(locale), {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'short' : undefined,
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function number(value: number, locale: DocLocale): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}

/** A {ar, en} value as plain text (spreadsheets): "عربي / English" when bilingual. */
export function locText(value: { ar?: string | null; en?: string | null }, locale: DocLocale) {
  const ar = value.ar ?? '';
  const en = value.en ?? '';
  if (locale !== 'both') return (locale === 'ar' ? ar : en) || ar || en;
  return !ar || !en || ar === en ? ar || en : `${ar} / ${en}`;
}
