import type { BookingDocumentData } from '@vs/engine';

/**
 * A made-up booking for the Branding screen's live preview and for tests. No real guest; the
 * company name and voucher note come from the company itself.
 */
export function sampleBooking(company: string): BookingDocumentData {
  const port = (en: string, ar: string) => ({ en, ar });
  const luxor = port('Luxor', 'الأقصر');
  const aswan = port('Aswan', 'أسوان');
  return {
    operator: {
      name: company,
      emergencyPhone: '+20 100 000 0000',
      voucherNote: { en: '', ar: '' },
    },
    booking: {
      ref: 'RD-26-00042',
      channelRef: null,
      channel: 'Back office',
      status: 'confirmed',
      paymentStatus: 'deposit_paid',
      market: 'international',
      currency: 'USD',
      total: 168000n,
      fees: 0n,
      amountPaid: 42000n,
      penalty: null,
      createdAt: new Date('2026-10-01T09:00:00Z'),
    },
    vessel: 'MS Sample',
    sailing: {
      patternCode: 'LXR4',
      name: { en: '4 nights from Luxor', ar: '٤ ليالٍ من الأقصر' },
      nights: 4,
      embark: { date: '2026-11-16', port: luxor, time: '12:00' },
      disembark: { date: '2026-11-20', port: aswan, time: '08:00' },
    },
    days: [
      { day: 1, date: '2026-11-16', stops: [{ port: luxor, arrive: null, depart: null }] },
      {
        day: 2,
        date: '2026-11-17',
        stops: [
          { port: port('Esna', 'إسنا'), arrive: '07:00', depart: '10:00' },
          { port: port('Edfu', 'إدفو'), arrive: '18:00', depart: null },
        ],
      },
      {
        day: 3,
        date: '2026-11-18',
        stops: [{ port: port('Kom Ombo', 'كوم أمبو'), arrive: '14:00', depart: '18:00' }],
      },
      { day: 4, date: '2026-11-19', stops: [{ port: aswan, arrive: '07:00', depart: null }] },
      { day: 5, date: '2026-11-20', stops: [{ port: aswan, arrive: null, depart: '08:00' }] },
    ],
    cabins: [
      {
        index: 0,
        category: { code: 'STD', en: 'Standard', ar: 'قياسية' },
        cabinNumber: '204',
        adults: 2,
        childAges: [],
        guests: [
          { name: 'Sara Ahmed', lead: true },
          { name: 'Omar Ahmed', lead: false },
        ],
      },
    ],
    board: 'full_board',
    inclusions: {
      en: ['Full board on board', 'Guided visits as per itinerary'],
      ar: ['إقامة كاملة على متن المركب', 'زيارات بصحبة مرشد حسب البرنامج'],
    },
    exclusions: { en: ['Drinks', 'Tips'], ar: ['المشروبات', 'الإكراميات'] },
    needsResidencyProof: false,
    paymentsDue: [{ kind: 'balance', amount: 126000n, dueDate: '2026-10-17' }],
    payments: [
      {
        kind: 'deposit',
        method: 'bank_transfer',
        amount: 42000n,
        currency: 'USD',
        reference: 'TRF-1188',
        receivedOn: '2026-10-02',
      },
    ],
    cancellation: [
      { fromDays: 30, penaltyBps: 2500 },
      { fromDays: 0, penaltyBps: 10000 },
    ],
  };
}
