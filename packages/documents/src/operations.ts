import type {
  CheckinGuest,
  DailyProgrammeData,
  DepartureCheckin,
  DocumentBrand,
  PredepartureData,
} from '@vs/engine';
import { e, loc, ltr, page } from './html';
import { date, number, textTranslator, translator, type DocLocale } from './i18n';

/**
 * On-board operations documents (Batch D3):
 * - per departure: the kitchen's diets and allergies and the occasions (everyone aboard), the
 *   cabin door cards (those boarding) and the disembarkation and transfer list (those leaving);
 * - per vessel: the daily programme, one page per day, to print and slide under doors;
 * - per booking: the guest's pre-departure information.
 * None carries passport numbers or money.
 */

const cabinOf = (party: DepartureCheckin['parties'][number], locale: DocLocale) =>
  party.cabin
    ? ltr(party.cabin.number)
    : `<span class="muted">${translator(locale)('notAssigned')}</span>`;
const guestName = (g: CheckinGuest) => e(`${g.lastName}, ${g.firstName}`);
const route = (d: DepartureCheckin, locale: DocLocale) =>
  `${loc({ ar: d.leg.from.nameAr, en: d.leg.from.nameEn }, locale)} → ${loc({ ar: d.leg.to.nameAr, en: d.leg.to.nameEn }, locale)}`;
/** Free text typed by the company: line breaks kept. */
const block = (value: string | null) => (value ? e(value).replace(/\n/g, '<br>') : '');
const bilingual = (ar: string | null, en: string | null, locale: DocLocale) => {
  if (locale === 'ar') return block(ar || en);
  if (locale === 'en') return block(en || ar);
  return ar && en && ar !== en
    ? `${block(ar)}<div class="en-block" dir="ltr">${block(en)}</div>`
    : block(ar || en);
};

function facts(d: DepartureCheckin, locale: DocLocale, extra = '') {
  const t = translator(locale);
  return `<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departs')}</span><span class="v">${date(d.leg.departDate, locale)}${d.leg.departTime ? ` · ${ltr(d.leg.departTime)}` : ''}</span></div>
  <div class="kv"><span class="k">${t('cruise')}</span><span class="v">${route(d, locale)}</span></div>
  ${extra}
</div>`;
}

const STYLE = `<style>
.small { font-size: 8.5pt; }
.en-block { font-family: 'Noto Sans', sans-serif; color: var(--muted); font-size: .9em; }
.allergy { color: #b42318; font-weight: 700; }
.soon { background: var(--accent-tint); }
td.cabin { font-weight: 700; white-space: nowrap; }
</style>`;

/** The kitchen and restaurant: every guest aboard with a diet or allergy, by cabin. */
export function dietListHtml(d: DepartureCheckin, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const rows = d.parties.flatMap((party) =>
    party.guests
      .filter((g) => g.dietary.length > 0 || g.allergies)
      .map(
        (g) => `<tr>
<td class="cabin">${cabinOf(party, locale)}</td>
<td>${guestName(g)}${g.lead ? '' : ''}</td>
<td>${g.dietary.map((x) => t(x)).join(', ') || '—'}</td>
<td>${g.allergies ? `<span class="allergy">${e(g.allergies)}</span>` : '—'}</td>
<td class="small">${e(party.ref)}</td></tr>`,
      ),
  );
  const counts = Object.entries(
    d.parties
      .flatMap((x) => x.guests)
      .flatMap((g) => [...g.dietary, ...(g.allergies ? ['allergies'] : [])])
      .reduce<Record<string, number>>((acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }), {}),
  )
    .map(([k, n]) => `${t(k === 'allergies' ? 'opAllergies' : k)} <b>${number(n, locale)}</b>`)
    .join(' · ');
  const aboard = d.parties.reduce((s, x) => s + x.guests.length, 0);
  const body = `${STYLE}
${facts(d, locale, `<div class="kv"><span class="k">${t('opAboard')}</span><span class="v">${t('totalGuests', { n: number(aboard, locale) })}</span></div>`)}
${counts ? `<p>${counts}</p>` : ''}
${
  rows.length
    ? `<table><thead><tr><th>${t('cabin')}</th><th>${t('guests')}</th><th>${t('opDiet')}</th><th>${t('opAllergies')}</th><th>${t('bookingRef')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="muted">${t('opNoDiets')}</p>`
}`;
  return page({
    locale,
    brand,
    title: `${p('diet_list')} ${d.leg.departDate}`,
    heading: t('diet_list'),
    subtitle: date(d.leg.departDate, locale),
    body,
  });
}

/** Cakes and surprises: guests aboard with an occasion, the date highlighted when it falls aboard. */
export function occasionListHtml(d: DepartureCheckin, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const rows = d.parties.flatMap((party) =>
    party.guests
      .filter((g) => g.occasion)
      .map((g) => {
        const aboard =
          g.occasionDate !== null &&
          g.occasionDate >= d.leg.departDate &&
          g.occasionDate <= party.disembark.date;
        return `<tr class="${aboard ? 'soon' : ''}">
<td class="cabin">${cabinOf(party, locale)}</td>
<td>${guestName(g)}</td>
<td>${t(g.occasion === 'other' ? 'otherOccasion' : g.occasion!)}</td>
<td>${g.occasionDate ? date(g.occasionDate, locale, 'short') : '—'}${aboard ? ` · <b>${t('opDuring')}</b>` : ''}</td>
<td class="small">${e(party.ref)}</td></tr>`;
      }),
  );
  const body = `${STYLE}
${facts(d, locale)}
${
  rows.length
    ? `<table><thead><tr><th>${t('cabin')}</th><th>${t('guests')}</th><th>${t('opOccasion')}</th><th>${t('opOn')}</th><th>${t('bookingRef')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="muted">${t('opNoOccasions')}</p>`
}`;
  return page({
    locale,
    brand,
    title: `${p('occasion_list')} ${d.leg.departDate}`,
    heading: t('occasion_list'),
    subtitle: date(d.leg.departDate, locale),
    body,
  });
}

/** One card per cabin boarding, two to a page: the vessel, the cabin and the guests' names. */
export function doorCardsHtml(d: DepartureCheckin, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const cards = d.parties.map(
    (party) => `<section class="door">
  ${brand.logo ? `<img src="${e(brand.logo)}" alt="">` : `<div class="brand">${e(brand.name)}</div>`}
  <div class="welcome">${t('opWelcome')}</div>
  <div class="vessel">${e(d.leg.vessel)}</div>
  <div class="names">${
    party.guests.length
      ? party.guests
          .map(
            (g) =>
              `<div>${e([g.title ? p(g.title) : '', g.firstName, g.lastName].filter(Boolean).join(' '))}</div>`,
          )
          .join('')
      : // No names entered for this cabin yet: the booking, so housekeeping can still match it.
        `<div class="muted">${ltr(party.ref)}</div>`
  }</div>
  <div class="cabin-no">${party.cabin ? ltr(party.cabin.number) : ''}</div>
  <div class="dates">${date(d.leg.departDate, locale, 'short')} – ${date(party.disembark.date, locale, 'short')}</div>
</section>`,
  );
  const body = `<style>
.sheet { break-after: page; }
.sheet:last-child { break-after: auto; }
.door { height: 125mm; border: 1.5px solid var(--brand-line); border-radius: 12px; margin-bottom: 6mm; padding: 10mm; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; break-inside: avoid; }
.door img { max-height: 18mm; max-width: 50mm; margin-bottom: 6mm; }
.door .brand { font-weight: 700; color: var(--brand-text); margin-bottom: 6mm; }
.door .welcome { font-size: 13pt; color: var(--muted); }
.door .vessel { font-size: 18pt; font-weight: 700; color: var(--brand-text); margin-bottom: 8mm; }
.door .names { font-size: 16pt; font-weight: 600; line-height: 1.5; }
.door .cabin-no { margin-top: 8mm; font-size: 26pt; font-weight: 800; color: var(--accent-text); }
.door .dates { margin-top: 3mm; color: var(--muted); }
</style>
${
  // Two cards to an A4 sheet, cut in half.
  cards.length
    ? Array.from(
        { length: Math.ceil(cards.length / 2) },
        (_, i) => `<div class="sheet">${cards.slice(i * 2, i * 2 + 2).join('')}</div>`,
      ).join('')
    : `<p class="muted">${t('none')}</p>`
}`;
  return page({
    locale,
    brand,
    title: `${p('door_cards')} ${d.leg.departDate}`,
    heading: t('door_cards'),
    subtitle: date(d.leg.departDate, locale),
    body,
    bare: true,
  });
}

/**
 * Who leaves where this departure ends: cabin, guests, flight home and time, with the vessel's
 * luggage-out and check-out times.
 */
export function disembarkationListHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
  vessel: { luggageTime: string | null; checkoutTime: string | null },
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const flightOf = (g: CheckinGuest) =>
    [
      g.departureFlight ? ltr(g.departureFlight) : '',
      g.departureDate && g.departureDate !== d.leg.arriveDate
        ? date(g.departureDate, locale, 'short')
        : '',
      g.departureTime ? ltr(g.departureTime) : '',
    ]
      .filter(Boolean)
      .join(' · ') || '—';
  // Earliest flight first, so transfers can be planned in order.
  const parties = [...d.parties].sort((a, b) => {
    const first = (x: typeof a) =>
      x.guests.map((g) => `${g.departureDate ?? '9999'} ${g.departureTime ?? '99:99'}`).sort()[0] ??
      '9999';
    return first(a).localeCompare(first(b));
  });
  const rows = parties.map(
    (party) => `<tr>
<td class="cabin">${cabinOf(party, locale)}</td>
<td>${party.guests.map((g) => `<div>${guestName(g)}</div>`).join('')}</td>
<td>${party.guests.map((g) => `<div>${flightOf(g)}</div>`).join('')}</td>
<td class="small">${e(party.ref)} · ${e(party.channel)}</td>
<td class="small">${party.guests
      .map((g) => g.phone)
      .filter(Boolean)
      .map(ltr)
      .join('<br>')}</td></tr>`,
  );
  const timing = [
    d.leg.arriveTime
      ? `<div class="kv"><span class="k">${t('opArrives')}</span><span class="v">${ltr(d.leg.arriveTime)}</span></div>`
      : '',
    vessel.luggageTime
      ? `<div class="kv"><span class="k">${t('opLuggage')}</span><span class="v">${ltr(vessel.luggageTime)}</span></div>`
      : '',
    vessel.checkoutTime
      ? `<div class="kv"><span class="k">${t('opCheckout')}</span><span class="v">${ltr(vessel.checkoutTime)}</span></div>`
      : '',
  ].join('');
  const port = loc({ ar: d.leg.to.nameAr, en: d.leg.to.nameEn }, locale);
  const body = `${STYLE}
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('disembark')}</span><span class="v">${port} · ${date(d.leg.arriveDate, locale)}</span></div>
  <div class="kv"><span class="k">${t('guests')}</span><span class="v">${t('cabinsN', { n: number(d.parties.length, locale) })} · ${t(
    'totalGuests',
    {
      n: number(
        d.parties.reduce((s, x) => s + x.guests.length, 0),
        locale,
      ),
    },
  )}</span></div>
  ${timing}
</div>
${
  rows.length
    ? `<table><thead><tr><th>${t('cabin')}</th><th>${t('guests')}</th><th>${t('opFlight')}</th><th>${t('bookingRef')}</th><th>${t('phone')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    : `<p class="muted">${t('opNoneLeaving')}</p>`
}`;
  return page({
    locale,
    brand,
    title: `${p('disembarkation_list')} ${d.leg.arriveDate}`,
    heading: t('disembarkation_list'),
    subtitle: `${port} · ${date(d.leg.arriveDate, locale)}`,
    body,
  });
}

/** One page per day: arrivals and departures, visits, meals and the vessel's note. */
export function dailyProgrammeHtml(d: DailyProgrammeData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const v = d.vessel;
  const meals = (
    [
      ['opBreakfast', v.breakfastTime],
      ['opLunch', v.lunchTime],
      ['opTea', v.teaTime],
      ['opDinner', v.dinnerTime],
    ] as const
  ).filter(([, at]) => at);
  const pages = d.days.map((day, i) => {
    const stops = day.stops
      .map((s) => {
        const port = loc({ ar: s.port.nameAr, en: s.port.nameEn }, locale);
        return `<tr><td class="time">${s.time ? ltr(s.time) : ''}</td><td>${t(s.time ? (s.kind === 'arrive' ? 'opArrive' : 'opDepart') : 'opAt', { port })}</td></tr>`;
      })
      .join('');
    const visits = day.visits
      .map(
        (x) =>
          `<div class="visit"><b>${loc({ ar: x.port.nameAr, en: x.port.nameEn }, locale)}</b><div>${bilingual(x.ar, x.en, locale)}</div></div>`,
      )
      .join('');
    return `<section class="day">
  <div class="day-head"><span class="n">${t('opDay', { n: number(i + 1, locale) })}</span><span>${date(day.date, locale)}</span></div>
  ${stops ? `<table class="plan"><tbody>${stops}</tbody></table>` : `<p class="muted">${t('opSailing')}</p>`}
  ${visits ? `<h2>${t('opVisits')}</h2>${visits}` : ''}
  ${
    meals.length
      ? `<h2>${t('opMeals')}</h2><table class="plan"><tbody>${meals
          .map(([k, at]) => `<tr><td class="time">${ltr(at!)}</td><td>${t(k)}</td></tr>`)
          .join('')}</tbody></table>`
      : ''
  }
  ${v.programmeNoteAr || v.programmeNoteEn ? `<p class="note">${bilingual(v.programmeNoteAr, v.programmeNoteEn, locale)}</p>` : ''}
</section>`;
  });
  const body = `<style>
.en-block { font-family: 'Noto Sans', sans-serif; color: var(--muted); font-size: .9em; }
.day { break-after: page; }
.day:last-of-type { break-after: auto; }
.day-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 3px solid var(--accent); padding-bottom: 4px; margin-bottom: 10px; font-size: 13pt; }
.day-head .n { font-weight: 800; color: var(--brand-text); font-size: 16pt; }
table.plan td { border: none; padding: 4px 6px; font-size: 11pt; }
table.plan td.time { width: 22mm; font-weight: 700; color: var(--brand-text); }
.visit { margin-bottom: 6px; }
.note { margin-top: 10mm; color: var(--muted); }
</style>
${pages.join('')}`;
  return page({
    locale,
    brand,
    title: `${p('daily_programme')} ${v.name} ${d.days[0]?.date ?? ''}`,
    heading: t('daily_programme'),
    subtitle: e(v.name),
    body,
  });
}

/** The guest's letter before the cruise: where and when to board, what to bring, documents. */
export function predepartureHtml(d: PredepartureData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const lead = d.guests.find((g) => g.lead) ?? d.guests[0];
  const embarkPort = loc({ ar: d.embark.port.nameAr, en: d.embark.port.nameEn }, locale);
  const endPort = loc({ ar: d.disembark.port.nameAr, en: d.disembark.port.nameEn }, locale);
  const pick = (
    ar: string | null,
    en: string | null,
    fallback: 'pdBringDefault' | 'pdDressDefault' | 'pdDocsDefault',
  ) => (ar || en ? bilingual(ar, en, locale) : t(fallback).replace(/\n/g, '<br>'));
  const list = (html: string) =>
    html.includes('<br>')
      ? `<ul>${html
          .split('<br>')
          .map((x) => `<li>${x}</li>`)
          .join('')}</ul>`
      : `<p>${html}</p>`;
  const body = `<style>
.en-block { font-family: 'Noto Sans', sans-serif; color: var(--muted); font-size: .9em; }
.box { border: 1px solid var(--rule); border-radius: 8px; padding: 6px 12px; margin-bottom: 8px; }
.box h2 { margin-top: 0; }
.box p { margin: 3px 0; }
.big { font-size: 12pt; font-weight: 700; color: var(--brand-text); }
ul { margin: 4px 0; padding-inline-start: 18px; }
</style>
${lead ? `<p>${t('pdHello', { name: e(lead.name) })}</p>` : ''}
<p>${t('pdIntro')}</p>
<div class="facts">
  <div class="kv"><span class="k">${t('bookingRef')}</span><span class="v">${ltr(d.ref)}</span></div>
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('cruise')}</span><span class="v">${d.cruise.nameEn || d.cruise.nameAr ? loc({ ar: d.cruise.nameAr, en: d.cruise.nameEn }, locale) : `${t('nights')} ${number(d.cruise.nights, locale)}`}</span></div>
  ${d.guests.length ? `<div class="kv"><span class="k">${t('guests')}</span><span class="v">${d.guests.map((g) => e(g.name)).join(' · ')}</span></div>` : ''}
</div>
<div class="box">
  <h2>${t('pdWhere')}</h2>
  <div class="big">${embarkPort} · ${date(d.embark.date, locale)}</div>
  ${d.embark.berthAr || d.embark.berthEn ? `<p><b>${t('pdBerth')}:</b> ${bilingual(d.embark.berthAr, d.embark.berthEn, locale)}</p>` : ''}
  ${d.embark.boardingTime ? `<p>${t('pdBoarding', { t: ltr(d.embark.boardingTime) })}</p>` : ''}
  ${d.embark.departTime ? `<p>${t('pdSails', { t: ltr(d.embark.departTime) })}</p>` : ''}
</div>
<div class="box">
  <h2>${t('pdEnd')}</h2>
  <div class="big">${endPort} · ${date(d.disembark.date, locale)}</div>
  ${d.disembark.arriveTime ? `<p>${t('pdArrive', { t: ltr(d.disembark.arriveTime) })}</p>` : ''}
  ${d.disembark.checkoutTime ? `<p>${t('pdCheckout', { t: ltr(d.disembark.checkoutTime) })}</p>` : ''}
</div>
<div class="box"><h2>${t('pdDocuments')}</h2><p>${pick(d.texts.documentsAr, d.texts.documentsEn, 'pdDocsDefault')}</p>
  <p><b>${t('pdPassportValid', { d: date(d.passportValidUntil, locale) })}</b></p></div>
<div class="box"><h2>${t('pdBring')}</h2>${list(pick(d.texts.whatToBringAr, d.texts.whatToBringEn, 'pdBringDefault'))}</div>
<div class="box"><h2>${t('pdDress')}</h2><p>${pick(d.texts.dressCodeAr, d.texts.dressCodeEn, 'pdDressDefault')}</p></div>
`;
  return page({
    locale,
    brand,
    title: `${p('predeparture')} ${d.ref}`,
    heading: t('predeparture'),
    subtitle: ltr(d.ref),
    body,
  });
}
