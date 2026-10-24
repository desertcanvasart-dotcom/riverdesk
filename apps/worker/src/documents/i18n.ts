/** Document wording in both languages, and locale-aware formatting (integer minor units in). */

export type Locale = 'ar' | 'en';

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
};

export type Key = keyof typeof en;

export function translator(locale: Locale) {
  const dict = locale === 'ar' ? ar : en;
  return (key: Key | string, values: Record<string, string | number> = {}) => {
    const text = (dict as Record<string, string>)[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
  };
}

const tag = (locale: Locale) => (locale === 'ar' ? 'ar-EG' : 'en-GB');

export function money(amount: bigint, currency: string, locale: Locale): string {
  const negative = amount < 0n;
  const abs = (negative ? -amount : amount).toString().padStart(3, '0');
  const decimal = `${negative ? '-' : ''}${abs.slice(0, -2)}.${abs.slice(-2)}`;
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(decimal as unknown as number);
}

export function date(value: string, locale: Locale, style: 'short' | 'long' = 'long'): string {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(tag(locale), {
    timeZone: 'UTC',
    weekday: style === 'long' ? 'short' : undefined,
    day: 'numeric',
    month: style === 'long' ? 'long' : 'short',
    year: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(tag(locale)).format(value);
}

export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
}
