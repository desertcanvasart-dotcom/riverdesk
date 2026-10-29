import type {
  BoardingPassData,
  CheckinGuest,
  DepartureCheckin,
  DocumentBrand,
  ExcursionData,
  HousekeepingData,
  TransferVoucherData,
} from '@vs/engine';
import { e, loc, ltr, page } from './html';
import { date, number, textTranslator, translator, type DocLocale } from './i18n';

/**
 * The remaining stationery (Batch D4): the transfer voucher and boarding passes (per booking),
 * luggage tags, excursion groups, the restaurant table plan, the safety muster list and
 * feedback forms (per departure), and the housekeeping cabin status sheet (per vessel and day).
 * None carries passport numbers or money.
 */

const LANGUAGES = [
  'ar',
  'en',
  'de',
  'fr',
  'it',
  'es',
  'pt',
  'nl',
  'ru',
  'zh',
  'ja',
  'ko',
  'pl',
  'cs',
];
const languageName = (code: string, locale: DocLocale) =>
  LANGUAGES.includes(code) ? translator(locale)(`lang_${code}`) : e(code.toUpperCase());
const fullName = (g: CheckinGuest, p: (key: string) => string) =>
  e([g.title ? p(g.title) : '', g.firstName, g.lastName].filter(Boolean).join(' '));
const portName = (port: { nameAr: string; nameEn: string }, locale: DocLocale) =>
  loc({ ar: port.nameAr, en: port.nameEn }, locale);

/** Pieces of a sheet cut into equal parts: `per` items to an A4 page. */
function sheets(items: string[], per: number, empty: string) {
  if (!items.length) return empty;
  return Array.from(
    { length: Math.ceil(items.length / per) },
    (_, i) => `<div class="cut-sheet">${items.slice(i * per, i * per + per).join('')}</div>`,
  ).join('');
}
const SHEET = `.cut-sheet { break-after: page; } .cut-sheet:last-child { break-after: auto; }`;

// ---------------------------------------------------------------------------
// Per booking
// ---------------------------------------------------------------------------

/** To the vessel on arrival, back to the airport at the end; guests on one flight together. */
export function transferVoucherHtml(
  d: TransferVoucherData,
  brand: DocumentBrand,
  locale: DocLocale,
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const group = (key: (g: TransferVoucherData['transferGuests'][number]) => string) => {
    const map = new Map<string, string[]>();
    for (const g of d.transferGuests) map.set(key(g), [...(map.get(key(g)) ?? []), g.name]);
    return [...map];
  };
  const arrivals = group((g) => JSON.stringify(g.arrival));
  const departures = group((g) => JSON.stringify(g.departure));
  const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const flightCells = (f: { date: string | null; flight: string | null; extra: string | null }) =>
    f.flight
      ? [
          ltr(f.flight),
          f.date ? date(f.date, locale, 'short') : '—',
          f.extra ? (/^\d/.test(f.extra) ? ltr(f.extra) : e(f.extra)) : '—',
        ]
      : [`<span class="muted">${t('trNoFlight')}</span>`, '', ''];
  const arrivalRows = arrivals
    .map(([k, names]) => {
      const a = JSON.parse(k) as TransferVoucherData['transferGuests'][number]['arrival'];
      return row([
        names.map(e).join('<br>'),
        ...flightCells({ date: a.date, flight: a.flight, extra: a.port }),
      ]);
    })
    .join('');
  const departureRows = departures
    .map(([k, names]) => {
      const x = JSON.parse(k) as TransferVoucherData['transferGuests'][number]['departure'];
      return row([
        names.map(e).join('<br>'),
        ...flightCells({ date: x.date, flight: x.flight, extra: x.time }),
      ]);
    })
    .join('');
  const embark = portName(d.embark.port, locale);
  const end = portName(d.disembark.port, locale);
  const body = `<style>.box { border: 1px solid var(--rule); border-radius: 8px; padding: 6px 12px; margin-bottom: 10px; } .box h2 { margin-top: 0; }</style>
<div class="facts">
  <div class="kv"><span class="k">${t('bookingRef')}</span><span class="v">${ltr(d.ref)}</span></div>
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
</div>
<div class="box"><h2>${t('trArrival')}</h2>
  <p>${t('trArrivalText', { port: embark, date: date(d.embark.date, locale) })}</p>${d.embark.boardingTime ? `<p>${t('pdBoarding', { t: ltr(d.embark.boardingTime) })}</p>` : ''}
  <table><thead><tr><th>${t('guests')}</th><th>${t('trFlight')}</th><th>${t('trDate')}</th><th>${t('trFrom')}</th></tr></thead><tbody>${arrivalRows}</tbody></table>
</div>
<div class="box"><h2>${t('trDeparture')}</h2>
  <p>${t('trDepartureText', { port: end, date: date(d.disembark.date, locale) })}</p>${d.disembark.checkoutTime ? `<p>${t('pdCheckout', { t: ltr(d.disembark.checkoutTime) })}</p>` : ''}
  <table><thead><tr><th>${t('guests')}</th><th>${t('trFlight')}</th><th>${t('trDate')}</th><th>${t('trTime')}</th></tr></thead><tbody>${departureRows}</tbody></table>
</div>
<p><b>${t('trPresent')}</b></p>`;
  return page({
    locale,
    brand,
    title: `${p('transfer_voucher')} ${d.ref}`,
    heading: t('transfer_voucher'),
    subtitle: ltr(d.ref),
    body,
  });
}

/** One pass per cabin, two to a page, each with a QR code of the booking and cabin. */
export function boardingPassHtml(
  d: BoardingPassData,
  brand: DocumentBrand,
  locale: DocLocale,
  /** QR code SVGs by pass code, made by the worker. */
  qr: Record<string, string>,
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const passes = d.passes.map(
    (pass) => `<section class="pass">
  <div class="pass-main">
    <div class="pass-head">${brand.logo ? `<img src="${e(brand.logo)}" alt="">` : ''}<div><div class="pass-title">${t('boarding_pass')}</div><div class="muted">${e(d.vessel)} · ${ltr(d.ref)}</div></div></div>
    <div class="grid2">
      <div><div class="k">${t('embark')}</div><div class="v">${portName(d.embark.port, locale)}<br>${date(d.embark.date, locale)}</div></div>
      <div><div class="k">${t('disembark')}</div><div class="v">${portName(d.disembark.port, locale)}<br>${date(d.disembark.date, locale)}</div></div>
      <div><div class="k">${t('bpBoarding')}</div><div class="v">${d.embark.boardingTime ? ltr(d.embark.boardingTime) : '—'}</div></div>
      <div><div class="k">${t('bpSails')}</div><div class="v">${d.embark.departTime ? ltr(d.embark.departTime) : '—'}</div></div>
    </div>
    <div class="k">${t('bpGuests')}</div><div class="v">${pass.guests.map(e).join(' · ') || '—'}</div>
    <div class="muted small scan">${t('bpScan')}</div>
  </div>
  <div class="pass-side">
    <div class="qr">${qr[pass.code] ?? ''}</div>
    <div class="k">${t('bpCabin')}</div><div class="cabin-no">${pass.cabin ? ltr(pass.cabin) : '—'}</div>
    <div class="muted small">${loc({ ar: pass.category.nameAr, en: pass.category.nameEn }, locale)}</div>
  </div>
</section>`,
  );
  const body = `<style>
${SHEET}
.pass { display: flex; border: 1.5px solid var(--brand-line); border-radius: 12px; height: 120mm; margin-bottom: 8mm; overflow: hidden; break-inside: avoid; }
.pass-main { flex: 1; padding: 8mm; display: flex; flex-direction: column; gap: 4mm; }
.pass-side { width: 62mm; padding: 8mm 6mm; border-inline-start: 2px dashed var(--rule); text-align: center; background: var(--brand-tint); }
.pass-head { display: flex; align-items: center; gap: 10px; border-bottom: 3px solid var(--accent); padding-bottom: 4px; }
.pass-head img { max-height: 11mm; max-width: 28mm; }
.pass-title { font-size: 14pt; font-weight: 800; color: var(--brand-text); }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm 8mm; }
.k { font-size: 8pt; color: var(--muted); text-transform: uppercase; }
.v { font-weight: 700; }
.qr svg { width: 40mm; height: 40mm; }
.qr { background: #fff; padding: 2mm; border-radius: 6px; display: inline-block; margin-bottom: 4mm; }
.cabin-no { font-size: 24pt; font-weight: 800; color: var(--accent-text); }
.small { font-size: 8.5pt; }
.scan { margin-top: auto; }
</style>
${sheets(passes, 2, `<p class="muted">${t('none')}</p>`)}`;
  return page({
    locale,
    brand,
    title: `${p('boarding_pass')} ${d.ref}`,
    heading: t('boarding_pass'),
    subtitle: ltr(d.ref),
    body,
    bare: true,
  });
}

// ---------------------------------------------------------------------------
// Per departure
// ---------------------------------------------------------------------------

/** A tag per guest boarding, eight to a page: name, vessel, cabin, booking, embarkation. */
export function luggageTagsHtml(d: DepartureCheckin, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const tags = d.parties.flatMap((party) =>
    party.guests.map(
      (g) => `<div class="tag">
  ${brand.logo ? `<img src="${e(brand.logo)}" alt="">` : `<div class="brand">${e(brand.name)}</div>`}
  <div class="name">${fullName(g, p)}</div>
  <div class="row"><span>${t('ltVessel')}</span><b>${e(d.leg.vessel)}</b></div>
  <div class="row"><span>${t('ltCabin')}</span><b class="big">${party.cabin ? ltr(party.cabin.number) : '—'}</b></div>
  <div class="row"><span>${t('ltEmbark')}</span><b>${date(d.leg.departDate, locale, 'short')}</b></div>
  <div class="ref">${ltr(party.ref)}</div>
</div>`,
    ),
  );
  const body = `<style>
${SHEET}
.cut-sheet { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5mm; width: 100%; }
.tag { height: 63mm; border: 1.5px dashed var(--brand-line); border-radius: 10px; padding: 5mm 6mm; display: flex; flex-direction: column; gap: 1.5mm; break-inside: avoid; }
.tag img { max-height: 9mm; max-width: 30mm; align-self: flex-start; }
.tag .brand { font-weight: 700; color: var(--brand-text); }
.tag .name { font-size: 14pt; font-weight: 800; color: var(--brand-text); margin: 1mm 0; }
.tag .row { display: flex; justify-content: space-between; gap: 4mm; font-size: 10pt; }
.tag .row span { color: var(--muted); }
.tag .big { font-size: 16pt; color: var(--accent-text); }
.tag .ref { margin-top: auto; font-size: 8pt; color: var(--muted); }
</style>
${sheets(tags, 8, `<p class="muted">${t('none')}</p>`)}`;
  return page({
    locale,
    brand,
    title: `${p('luggage_tags')} ${d.leg.departDate}`,
    heading: t('luggage_tags'),
    subtitle: date(d.leg.departDate, locale),
    body,
    bare: true,
  });
}

/** For each visit: the groups by language, with a line for the guide's name. */
export function excursionListHtml(d: ExcursionData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const groupsTable = `<table><thead><tr><th>${t('exLanguage')}</th><th>${t('exGuests')}</th><th>${t('exGuide')}</th></tr></thead><tbody>${d.groups
    .map(
      (g) =>
        `<tr><td><b>${languageName(g.language, locale)}</b><div class="muted">${t('exPeople', { n: number(g.guests.length, locale) })}</div></td><td>${g.guests
          .map((x) => `${e(x.name)}${x.cabin ? ` <span class="muted">${ltr(x.cabin)}</span>` : ''}`)
          .join('<br>')}</td><td class="guide"></td></tr>`,
    )
    .join('')}</tbody></table>`;
  const visits = d.visits.length
    ? d.visits
        .map(
          (v) =>
            `<section class="visit"><h2>${date(v.date, locale, 'short')} · ${portName(v.port, locale)}</h2><p>${e(locale === 'ar' ? v.ar || v.en : v.en || v.ar)}</p>${groupsTable}</section>`,
        )
        .join('')
    : `<p class="muted">${t('exNoVisits')}</p><h2>${t('exGroups')}</h2>${groupsTable}`;
  const body = `<style>
.visit { break-inside: avoid; margin-bottom: 8mm; }
td.guide { width: 35%; border-bottom: 1px solid var(--ink); }
</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departs')}</span><span class="v">${date(d.departDate, locale)} – ${date(d.arriveDate, locale)}</span></div>
</div>
${visits}`;
  return page({
    locale,
    brand,
    title: `${p('excursion_list')} ${d.departDate}`,
    heading: t('excursion_list'),
    subtitle: date(d.departDate, locale),
    body,
  });
}

/**
 * Each booking at its own tables (a party is not split from itself), tables of the vessel's
 * size, numbered in cabin order; diets and occasions noted for the waiters.
 */
export function tablePlanHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
  tableSize: number,
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const byBooking = new Map<string, DepartureCheckin['parties']>();
  for (const party of d.parties)
    byBooking.set(party.ref, [...(byBooking.get(party.ref) ?? []), party]);
  let table = 0;
  const rows: string[] = [];
  for (const [ref, parties] of byBooking) {
    const guests = parties.flatMap((x) =>
      x.guests.map((g) => ({ g, cabin: x.cabin?.number ?? null })),
    );
    for (let i = 0; i < Math.max(guests.length, 1); i += tableSize) {
      table += 1;
      const seated = guests.slice(i, i + tableSize);
      const notes = seated
        .flatMap(({ g }) => [
          ...g.dietary.map((x) => t(x)),
          g.allergies ? `${t('opAllergies')}: ${e(g.allergies)}` : '',
          g.occasion ? t(g.occasion === 'other' ? 'otherOccasion' : g.occasion) : '',
        ])
        .filter(Boolean);
      rows.push(`<tr>
<td class="tno">${t('tpTable', { n: number(table, locale) })}<div class="muted small">${t('tpSeats', { n: number(Math.max(seated.length, 1), locale) })}</div></td>
<td>${seated.map(({ g, cabin }) => `${fullName(g, p)}${cabin ? ` <span class="muted">${ltr(cabin)}</span>` : ''}`).join('<br>') || ltr(ref)}</td>
<td class="small">${[...new Set(notes)].join(' · ') || '—'}</td>
<td class="small">${ltr(ref)}</td></tr>`);
    }
  }
  const body = `<style>td.tno { font-weight: 800; color: var(--brand-text); white-space: nowrap; } .small { font-size: 8.5pt; }</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departs')}</span><span class="v">${date(d.leg.departDate, locale)}</span></div>
  <div class="kv"><span class="k">${t('guests')}</span><span class="v">${t('totalGuests', {
    n: number(
      d.parties.reduce((s, x) => s + x.guests.length, 0),
      locale,
    ),
  })} · ${t('tpSize', { n: number(tableSize, locale) })}</span></div>
</div>
${rows.length ? `<table><thead><tr><th></th><th>${t('tpGuests')}</th><th>${t('tpNotes')}</th><th>${t('bookingRef')}</th></tr></thead><tbody>${rows.join('')}</tbody></table>` : `<p class="muted">${t('none')}</p>`}`;
  return page({
    locale,
    brand,
    title: `${p('table_plan')} ${d.leg.departDate}`,
    heading: t('table_plan'),
    subtitle: date(d.leg.departDate, locale),
    body,
  });
}

/** By muster station (from each cabin's deck): cabins, guests, and life jackets to check. */
export function musterListHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
  stations: Record<string, string>,
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const groups = new Map<string, DepartureCheckin['parties']>();
  for (const party of d.parties) {
    const deck = party.cabin?.deck ?? '';
    const station = (deck && stations[deck]) || '';
    const key = `${station}\u0000${deck}`;
    groups.set(key, [...(groups.get(key) ?? []), party]);
  }
  let adults = 0;
  let children = 0;
  const sections = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, parties]) => {
      const [station, deck] = key.split('\u0000') as [string, string];
      const rows = parties
        .map((x) => {
          adults += x.adults;
          children += x.childAges.length;
          return `<tr><td class="cabin">${x.cabin ? ltr(x.cabin.number) : `<span class="muted">${t('notAssigned')}</span>`}</td><td>${x.guests.map((g) => fullName(g, p)).join('<br>') || ltr(x.ref)}</td><td class="num">${number(x.adults, locale)}</td><td class="num">${number(x.childAges.length, locale)}</td><td class="tick"></td></tr>`;
        })
        .join('');
      return `<h2>${station ? e(station) : `<span class="muted">${t('muNoStation')}</span>`}${deck ? ` · ${t('muDeck')} ${e(deck)}` : ''}</h2>
<table><thead><tr><th>${t('muCabin')}</th><th>${t('guests')}</th><th class="num">${t('muAdults')}</th><th class="num">${t('muChildren')}</th><th>✓</th></tr></thead><tbody>${rows}</tbody></table>`;
    })
    .join('');
  const body = `<style>td.cabin { font-weight: 700; } td.tick { width: 10mm; border: 1px solid var(--ink); }</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departs')}</span><span class="v">${date(d.leg.departDate, locale)}</span></div>
  <div class="kv"><span class="k">${t('muAdults')}</span><span class="v">${number(adults, locale)}</span></div>
  <div class="kv"><span class="k">${t('muChildren')}</span><span class="v">${number(children, locale)}</span></div>
</div>
${sections || `<p class="muted">${t('none')}</p>`}`;
  return page({
    locale,
    brand,
    title: `${p('muster_list')} ${d.leg.departDate}`,
    heading: t('muster_list'),
    subtitle: date(d.leg.departDate, locale),
    body,
  });
}

/** One form per cabin leaving, with five-point ratings and room for comments. */
export function feedbackFormsHtml(d: DepartureCheckin, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const questions = [
    'fbCabin',
    'fbFood',
    'fbService',
    'fbGuides',
    'fbCleanliness',
    'fbValue',
    'fbOverall',
  ];
  const forms = d.parties.map(
    (party) => `<section class="form">
  <div class="form-head">${brand.logo ? `<img src="${e(brand.logo)}" alt="">` : ''}<div><div class="form-title">${t('fbTitle')}</div><div class="muted">${e(d.leg.vessel)} · ${t('bpCabin')} ${party.cabin ? ltr(party.cabin.number) : '—'} · ${date(d.leg.arriveDate, locale, 'short')}</div></div></div>
  <p>${t('fbIntro')}</p>
  <table class="rate"><thead><tr><th></th><th>${t('fbExcellent')}</th><th></th><th></th><th></th><th>${t('fbPoor')}</th></tr></thead><tbody>
  ${questions.map((q) => `<tr><td>${t(q)}</td>${[5, 4, 3, 2, 1].map((n) => `<td class="box">${number(n, locale)}</td>`).join('')}</tr>`).join('')}
  </tbody></table>
  <p>${t('fbRecommend')} <span class="opt">☐ ${t('fbYes')}</span> <span class="opt">☐ ${t('fbNo')}</span></p>
  <div class="k">${t('fbComments')}</div><div class="lines"></div><div class="lines"></div><div class="lines"></div><div class="lines"></div>
  <div class="k">${t('fbName')}</div><div class="lines"></div>
  <div class="muted small">${party.guests.map((g) => fullName(g, p)).join(' · ')}</div>
</section>`,
  );
  const body = `<style>
.form { break-after: page; display: flex; flex-direction: column; gap: 3mm; }
.form:last-of-type { break-after: auto; }
.form-head { display: flex; align-items: center; gap: 10px; border-bottom: 3px solid var(--accent); padding-bottom: 4px; }
.form-head img { max-height: 12mm; max-width: 30mm; }
.form-title { font-size: 16pt; font-weight: 800; color: var(--brand-text); }
table.rate td.box { text-align: center; width: 13mm; color: var(--muted); border: 1px solid var(--rule); }
.opt { margin-inline-start: 8mm; }
.lines { border-bottom: 1px solid var(--rule); height: 9mm; }
.k { font-size: 9pt; color: var(--muted); margin-top: 2mm; }
.small { font-size: 8pt; }
</style>
${forms.join('') || `<p class="muted">${t('none')}</p>`}`;
  return page({
    locale,
    brand,
    title: `${p('feedback_forms')} ${d.leg.arriveDate}`,
    heading: t('feedback_forms'),
    subtitle: date(d.leg.arriveDate, locale),
    body,
    bare: true,
  });
}

// ---------------------------------------------------------------------------
// Per vessel and day
// ---------------------------------------------------------------------------

/** Every cabin and what to do in it today, by deck. */
export function housekeepingHtml(d: HousekeepingData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const rows = d.cabins
    .map(
      (c) => `<tr class="hk-${c.status}">
<td class="cabin">${ltr(c.number)}${c.accessible ? ` <span class="muted">♿</span>` : ''}</td>
<td>${c.deck ? e(c.deck) : '—'}</td>
<td><b>${t(`hk_${c.status}`)}</b></td>
<td class="num">${c.guests ? number(c.guests, locale) : '—'}${c.children ? ` <span class="muted">(${t('hkChildren')} ${number(c.children, locale)})</span>` : ''}</td>
<td>${c.occasion ? t(c.occasion === 'other' ? 'otherOccasion' : c.occasion) : ''}</td>
<td class="tick"></td></tr>`,
    )
    .join('');
  const totals = (['turnover', 'departing', 'arriving', 'stayover', 'vacant'] as const)
    .map((s) => `${t(`hk_${s}`)} <b>${number(d.totals[s], locale)}</b>`)
    .join(' · ');
  const body = `<style>
td.cabin { font-weight: 700; white-space: nowrap; }
td.tick { width: 10mm; border: 1px solid var(--ink); }
tr.hk-turnover td, tr.hk-departing td { background: var(--accent-tint); }
tr.hk-vacant td { color: var(--muted); }
</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('trDate')}</span><span class="v">${date(d.date, locale)}</span></div>
</div>
<p>${totals}</p>
<table><thead><tr><th>${t('cabin')}</th><th>${t('muDeck')}</th><th>${t('hkStatus')}</th><th class="num">${t('hkGuests')}</th><th>${t('hkNote')}</th><th>${t('hkDone')}</th></tr></thead><tbody>${rows}</tbody></table>
${d.unassigned.length ? `<h2>${t('hkUnassigned')}</h2><p>${d.unassigned.map((u) => `${ltr(u.ref)} (${number(u.guests, locale)})`).join(' · ')}</p>` : ''}`;
  return page({
    locale,
    brand,
    title: `${p('housekeeping_sheet')} ${d.date}`,
    heading: t('housekeeping_sheet'),
    subtitle: `${e(d.vessel)} · ${date(d.date, locale)}`,
    body,
  });
}
