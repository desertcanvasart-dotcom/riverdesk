import { describe, expect, it } from 'vitest';
import type {
  BoardingPassData,
  CheckinGuest,
  DepartureCheckin,
  DocumentBrand,
  ExcursionData,
  HousekeepingData,
} from '@vs/engine';
import {
  boardingPassHtml,
  excursionListHtml,
  feedbackFormsHtml,
  housekeepingHtml,
  luggageTagsHtml,
  musterListHtml,
  tablePlanHtml,
} from '../src/index';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};
const guest = (firstName: string, over: Partial<CheckinGuest> = {}) =>
  ({
    firstName,
    lastName: 'Meyer',
    lead: false,
    title: null,
    dietary: [],
    allergies: null,
    occasion: null,
    ...over,
  }) as CheckinGuest;
const party = (
  ref: string,
  cabin: string,
  deck: string,
  guests: CheckinGuest[],
  childAges: number[] = [],
) =>
  ({
    ref,
    cabin: { number: cabin, deck },
    adults: guests.length - childAges.length,
    childAges,
    guests,
    disembark: { date: '2026-11-20', port: 'ASW' },
  }) as unknown as DepartureCheckin['parties'][number];
const departure = (parties: DepartureCheckin['parties']) =>
  ({
    leg: {
      vessel: 'MS Nile <Star>',
      vesselId: 'v',
      departDate: '2026-11-16',
      arriveDate: '2026-11-20',
      from: { code: 'LXR' },
    },
    parties,
  }) as unknown as DepartureCheckin;

describe('the remaining stationery', () => {
  it('puts each boarding pass’s QR code beside its cabin', () => {
    const data = {
      ref: 'VS-26-00042',
      vessel: 'MS Nile Star',
      embark: {
        date: '2026-11-16',
        port: { nameAr: 'الأقصر', nameEn: 'Luxor' },
        boardingTime: '12:00',
        departTime: '15:00',
      },
      disembark: { date: '2026-11-20', port: { nameAr: 'أسوان', nameEn: 'Aswan' } },
      passes: [
        {
          cabin: '204',
          category: { nameAr: 'قياسية', nameEn: 'Standard' },
          guests: ['Klaus Meyer'],
          code: 'RD:VS-26-00042:1',
        },
      ],
    } as unknown as BoardingPassData;
    const html = boardingPassHtml(data, brand, 'en', {
      'RD:VS-26-00042:1': '<svg id="qr1"></svg>',
    });
    expect(html).toContain('<svg id="qr1"></svg>');
    expect(html).toContain('204');
    expect(html).toContain('Klaus Meyer');
  });

  it('prints eight luggage tags to a sheet, names escaped', () => {
    const guests = Array.from({ length: 9 }, (_, i) => guest(`G<${i}>`));
    const html = luggageTagsHtml(departure([party('VS-1', '101', 'Main', guests)]), brand, 'en');
    expect(html.match(/class="tag"/g)).toHaveLength(9);
    expect(html.match(/class="cut-sheet"/g)).toHaveLength(2);
    expect(html).toContain('G&lt;0&gt; Meyer');
  });

  it('lists each visit with its groups and a line for the guide', () => {
    const data: ExcursionData = {
      vessel: 'MS Nile Star',
      departDate: '2026-11-16',
      arriveDate: '2026-11-20',
      visits: [
        {
          date: '2026-11-17',
          port: { nameAr: 'إدفو', nameEn: 'Edfu' },
          ar: null,
          en: 'Temple of Horus',
        },
      ],
      groups: [{ language: 'de', guests: [{ name: 'Meyer, Klaus', cabin: '204', ref: 'VS-1' }] }],
    };
    const html = excursionListHtml(data, brand, 'en');
    expect(html).toContain('Temple of Horus');
    expect(html).toContain('German');
    expect(html).toContain('class="guide"');
    expect(excursionListHtml({ ...data, visits: [] }, brand, 'en')).toContain('No visits set');
  });

  it('seats a booking at its own tables of the vessel’s size', () => {
    const d = departure([
      party('VS-1', '101', 'Main', [guest('A'), guest('B'), guest('C')]),
      party('VS-2', '102', 'Main', [guest('D', { dietary: ['vegan'] })]),
    ]);
    const html = tablePlanHtml(d, brand, 'en', 2);
    // VS-1 needs two tables of two, VS-2 one.
    expect(html).toContain('Table 3');
    expect(html).not.toContain('Table 4');
    expect(html).toContain('Vegan');
  });

  it('groups cabins by muster station and counts adult and child jackets', () => {
    const d = departure([
      party('VS-1', '101', 'Main', [guest('A'), guest('B'), guest('C')], [6]),
      party('VS-2', '301', 'Upper', [guest('D')]),
    ]);
    const html = musterListHtml(d, brand, 'en', { Main: 'Station A' });
    expect(html).toContain('Station A');
    expect(html).toContain('No station set for this deck');
    expect(html).toMatch(/Adult jackets<\/span><span class="v">3</);
    expect(html).toMatch(/Child jackets<\/span><span class="v">1</);
  });

  it('prints a feedback form per cabin', () => {
    const d = departure([
      party('VS-1', '101', 'Main', [guest('A')]),
      party('VS-2', '102', 'Main', [guest('B')]),
    ]);
    const html = feedbackFormsHtml(d, brand, 'ar');
    expect(html.match(/class="form"/g)).toHaveLength(2);
    expect(html).toContain('كيف كانت رحلتكم؟');
  });

  it('marks each cabin’s status for housekeeping', () => {
    const data: HousekeepingData = {
      vessel: 'MS Nile Star',
      date: '2026-11-20',
      cabins: [
        {
          number: '101',
          deck: 'Main',
          category: null,
          accessible: false,
          status: 'turnover',
          guests: 2,
          children: 0,
          occasion: 'birthday',
        },
        {
          number: '102',
          deck: 'Main',
          category: null,
          accessible: true,
          status: 'vacant',
          guests: 0,
          children: 0,
          occasion: null,
        },
      ],
      unassigned: [{ ref: 'VS-9', guests: 2 }],
      totals: { vacant: 1, arriving: 0, departing: 0, turnover: 1, stayover: 0 },
    };
    const html = housekeepingHtml(data, brand, 'en');
    expect(html).toContain('Departing and arriving');
    expect(html).toContain('Birthday');
    expect(html).toContain('VS-9');
  });
});
