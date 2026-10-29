import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import type { CheckinGuest, DepartureCheckin, DocumentBrand } from '@vs/engine';
import { operationsXlsx } from '../src/documents/operations-xlsx';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};
const guest = (over: Partial<CheckinGuest>) =>
  ({
    firstName: 'Nadia',
    lastName: 'Farouk',
    lead: true,
    dietary: [],
    allergies: null,
    occasion: null,
    occasionDate: null,
    departureDate: null,
    departureFlight: null,
    departureTime: null,
    phone: null,
    ...over,
  }) as CheckinGuest;
const data = {
  leg: {
    id: 'l',
    vesselId: 'v',
    vessel: 'MS Nile Star',
    departDate: '2026-11-16',
    departTime: '15:00',
    arriveDate: '2026-11-20',
    arriveTime: '08:00',
    from: { code: 'LXR', nameEn: 'Luxor', nameAr: 'الأقصر' },
    to: { code: 'ASW', nameEn: 'Aswan', nameAr: 'أسوان' },
  },
  parties: [
    {
      ref: 'VS-26-00042',
      cabin: { number: '204', deck: null },
      guests: [
        guest({
          dietary: ['vegetarian'],
          allergies: 'Peanuts',
          departureFlight: 'MS 778',
          departureTime: '18:40',
        }),
        guest({ firstName: 'Omar', occasion: 'birthday', occasionDate: '2026-11-18' }),
      ],
    },
  ],
} as unknown as DepartureCheckin;

const rows = async (buffer: Buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const out: string[] = [];
  workbook.worksheets[0]!.eachRow((row) => out.push((row.values as unknown[]).slice(1).join('|')));
  return out;
};

describe('on-board lists as workbooks', () => {
  it('lists only guests with a diet or allergy for the kitchen', async () => {
    const out = await rows(await operationsXlsx('diet_list', data, brand, 'en'));
    expect(out).toContain('204|Farouk, Nadia|Vegetarian|Peanuts|VS-26-00042');
    expect(out.some((r) => r.includes('Omar'))).toBe(false);
  });

  it('lists occasions, and every guest leaving with the flight home', async () => {
    expect(await rows(await operationsXlsx('occasion_list', data, brand, 'en'))).toContain(
      '204|Farouk, Omar|Birthday|2026-11-18|VS-26-00042',
    );
    const leaving = await rows(await operationsXlsx('disembarkation_list', data, brand, 'en'));
    expect(leaving).toContain('204|Farouk, Nadia|MS 778||18:40||VS-26-00042');
    expect(leaving.some((r) => r.startsWith('204|Farouk, Omar'))).toBe(true);
  });
});
