import { describe, expect, it } from 'vitest';
import type {
  CheckinGuest,
  DailyProgrammeData,
  DepartureCheckin,
  DocumentBrand,
  PredepartureData,
} from '@vs/engine';
import {
  dailyProgrammeHtml,
  dietListHtml,
  disembarkationListHtml,
  doorCardsHtml,
  occasionListHtml,
  predepartureHtml,
} from '../src/index';

const brand: DocumentBrand = {
  name: 'Nile Star',
  logo: null,
  primary: '#165a5c',
  secondary: '#c97416',
  contact: { phone: null, whatsapp: null, email: null, website: null, address: { ar: '', en: '' } },
};

const guest = (over: Partial<CheckinGuest>): CheckinGuest => ({
  firstName: 'Nadia',
  lastName: 'Farouk',
  lead: true,
  title: null,
  gender: null,
  nationality: 'EG',
  dateOfBirth: null,
  placeOfBirth: null,
  passportCountry: null,
  passportIssuedOn: null,
  passportExpiresOn: null,
  hasPassport: true,
  visaType: null,
  arrivalDate: null,
  arrivalFlight: null,
  arrivalPort: null,
  language: null,
  departureDate: null,
  departureFlight: null,
  departureTime: null,
  phone: null,
  emergencyName: null,
  emergencyPhone: null,
  dietary: [],
  allergies: null,
  hasMedicalNotes: false,
  occasion: null,
  occasionDate: null,
  warnings: [],
  ...over,
});

const departure = (guests: CheckinGuest[]): DepartureCheckin => ({
  leg: {
    id: 'leg',
    vesselId: 'v',
    vessel: 'MS Nile <Star>',
    departDate: '2026-11-16',
    departTime: '15:00',
    arriveDate: '2026-11-20',
    arriveTime: '08:00',
    from: { code: 'LXR', nameEn: 'Luxor', nameAr: 'الأقصر' },
    to: { code: 'ASW', nameEn: 'Aswan', nameAr: 'أسوان' },
  },
  parties: [
    {
      bookingCabinId: 'bc',
      ref: 'VS-26-00042',
      channel: 'Cairo Travel',
      category: { code: 'STD', nameEn: 'Standard', nameAr: 'قياسية' },
      cabin: { number: '204', deck: 'Main' },
      adults: 2,
      childAges: [],
      disembark: { date: '2026-11-20', port: 'ASW' },
      checkin: { passportsSeen: false, cardsSigned: false, keyHanded: false, checkedInAt: null },
      guests,
    },
  ],
  totals: {
    cabins: 1,
    guests: guests.length,
    checkedIn: 0,
    nationalities: {},
    dietary: {},
    occasions: 0,
    warnings: 0,
  },
});

describe('on-board operations documents', () => {
  it('lists diets and allergies, with allergies stressed and text escaped', () => {
    const html = dietListHtml(
      departure([
        guest({ dietary: ['vegetarian'], allergies: 'Nuts <all>' }),
        guest({ firstName: 'Omar' }),
      ]),
      brand,
      'en',
    );
    expect(html).toContain('Special diets and allergies');
    expect(html).toContain('Nuts &lt;all&gt;');
    expect(html).toContain('MS Nile &lt;Star&gt;');
    expect(html).not.toContain('Farouk, Omar'); // no diet, not listed
    expect(dietListHtml(departure([guest({})]), brand, 'en')).toContain(
      'No special diets or allergies on this departure.',
    );
  });

  it('marks an occasion that falls during the cruise', () => {
    const html = occasionListHtml(
      departure([guest({ occasion: 'birthday', occasionDate: '2026-11-18' })]),
      brand,
      'en',
    );
    expect(html).toContain('during the cruise');
    expect(
      occasionListHtml(
        departure([guest({ occasion: 'honeymoon', occasionDate: '2027-02-01' })]),
        brand,
        'en',
      ),
    ).not.toContain('during the cruise');
  });

  it('prints one door card per cabin with the guests and cabin number', () => {
    const html = doorCardsHtml(departure([guest({}), guest({ firstName: 'Omar' })]), brand, 'ar');
    expect(html).toContain('أهلًا بكم على متن');
    expect(html).toContain('Nadia Farouk');
    expect(html).toContain('Omar Farouk');
    expect(html).toContain('204');
  });

  it('lists who leaves, with the flight home and the vessel’s luggage and check-out times', () => {
    const html = disembarkationListHtml(
      departure([
        guest({ departureFlight: 'MS 778', departureTime: '18:40', departureDate: '2026-11-21' }),
      ]),
      brand,
      'en',
      { luggageTime: '06:30', checkoutTime: '08:00' },
    );
    expect(html).toContain('MS 778');
    expect(html).toContain('18:40');
    expect(html).toContain('Luggage out');
    expect(html).toContain('06:30');
  });

  it('prints the daily programme a page per day, in both languages', () => {
    const data: DailyProgrammeData = {
      vessel: {
        id: 'v',
        name: 'MS Nile Star',
        boardingTime: '12:00',
        breakfastTime: '07:00',
        lunchTime: null,
        teaTime: null,
        dinnerTime: '19:30',
        luggageTime: null,
        checkoutTime: null,
        programmeNoteAr: null,
        programmeNoteEn: 'Galabeya party on the last night.',
        musterStations: {},
        tableSize: 4,
        decks: [],
      },
      days: [
        {
          date: '2026-11-16',
          stops: [
            {
              time: '15:00',
              kind: 'depart',
              port: { code: 'LXR', nameAr: 'الأقصر', nameEn: 'Luxor' },
            },
          ],
          visits: [{ port: { nameAr: 'الأقصر', nameEn: 'Luxor' }, ar: 'الكرنك', en: 'Karnak' }],
        },
        { date: '2026-11-17', stops: [], visits: [] },
      ],
    };
    const html = dailyProgrammeHtml(data, brand, 'both');
    expect(html.match(/class="day"/g)).toHaveLength(2);
    expect(html).toContain('Departure from');
    expect(html).toContain('الكرنك');
    expect(html).toContain('Karnak');
    expect(html).toContain('A day sailing on the Nile');
    expect(html).toContain('19:30');
  });

  it('writes the guest’s pre-departure letter with standard wording where the company has none', () => {
    const data: PredepartureData = {
      ref: 'VS-26-00042',
      vessel: 'MS Nile Star',
      cruise: { nameAr: '٤ ليالٍ من الأقصر', nameEn: '4 nights from Luxor', nights: 4 },
      embark: {
        date: '2026-11-16',
        port: { nameAr: 'الأقصر', nameEn: 'Luxor' },
        berthAr: null,
        berthEn: 'Corniche El Nil',
        boardingTime: '12:00',
        departTime: '15:00',
      },
      disembark: {
        date: '2026-11-20',
        port: { nameAr: 'أسوان', nameEn: 'Aswan' },
        arriveTime: '08:00',
        checkoutTime: '08:00',
      },
      guests: [{ name: 'Nadia Farouk', lead: true }],
      passportValidUntil: '2027-05-20',
      texts: {
        whatToBringAr: null,
        whatToBringEn: null,
        dressCodeAr: null,
        dressCodeEn: 'Smart casual <for> dinner.',
        documentsAr: null,
        documentsEn: null,
      },
    };
    const html = predepartureHtml(data, brand, 'en');
    expect(html).toContain('Dear Nadia Farouk,');
    expect(html).toContain('Corniche El Nil');
    expect(html).toContain('Boarding from');
    expect(html).toContain('Smart casual &lt;for&gt; dinner.');
    expect(html).toContain('Sunscreen'); // standard "what to bring"
    expect(html).toContain('<li>');
    expect(predepartureHtml(data, brand, 'ar')).toContain('قبل الإبحار');
  });
});
