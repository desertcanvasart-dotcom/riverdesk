import type { CheckinGuest, CheckinParty, DepartureCheckin, DocumentBrand } from '@vs/engine';
import { e, loc, ltr, page } from './html';
import { date, money, number, textTranslator, today, translator, type DocLocale } from './i18n';

/**
 * Check-in documents (Batch D2), one departure each:
 * - the embarkation sheet for the reception desk (no passport numbers, tick boxes, balances
 *   unless it is the on-board copy);
 * - the check-in file, every guest's full details for the police list (passport numbers);
 * - the guest registration cards, pre-filled, two to a page, signed at the desk.
 */

const box = (checked: boolean) =>
  `<span class="tick${checked ? ' on' : ''}">${checked ? '✓' : ''}</span>`;

function headerFacts(d: DepartureCheckin, locale: DocLocale) {
  const t = translator(locale);
  const from = loc({ ar: d.leg.from.nameAr, en: d.leg.from.nameEn }, locale);
  const to = loc({ ar: d.leg.to.nameAr, en: d.leg.to.nameEn }, locale);
  return `<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departs')}</span><span class="v">${date(d.leg.departDate, locale)}${d.leg.departTime ? ` · ${ltr(d.leg.departTime)}` : ''}</span></div>
  <div class="kv"><span class="k">${t('boarding')}</span><span class="v">${from} → ${to}</span></div>
  <div class="kv"><span class="k">${t('guests')}</span><span class="v">${t('cabinsN', { n: number(d.totals.cabins, locale) })} · ${t('totalGuests', { n: number(d.totals.guests, locale) })}</span></div>
</div>`;
}

const guestName = (g: CheckinGuest) => e(`${g.lastName}, ${g.firstName}`);

/** Short tags after a name: diet, occasion, a warning. */
function tags(g: CheckinGuest, locale: DocLocale) {
  const t = translator(locale === 'both' ? 'en' : locale);
  const out = [
    ...g.dietary.map((d) => `<span class="tag diet">${t(d)}</span>`),
    g.allergies ? `<span class="tag diet">${t('allergies')}</span>` : '',
    g.occasion
      ? `<span class="tag occ">${t(g.occasion === 'other' ? 'otherOccasion' : g.occasion)}</span>`
      : '',
    g.warnings.length ? `<span class="tag warn">!</span>` : '',
  ];
  return out.filter(Boolean).join(' ');
}

function arrival(guests: CheckinGuest[], locale: DocLocale) {
  const g = guests.find((x) => x.arrivalDate || x.arrivalFlight);
  if (!g) return '—';
  return [
    g.arrivalDate ? date(g.arrivalDate, locale, 'short') : '',
    g.arrivalFlight ? ltr(g.arrivalFlight) : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function summary(d: DepartureCheckin, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale === 'both' ? 'en' : locale);
  const list = (entries: [string, number][]) =>
    entries.length
      ? entries.map(([k, n]) => `${e(k)} <b>${number(n, locale)}</b>`).join(' · ')
      : `<span class="muted">${t('none')}</span>`;
  const nationalities = Object.entries(d.totals.nationalities).sort((a, b) => b[1] - a[1]);
  const diets = Object.entries(d.totals.dietary).map(([k, n]) => [p(k), n] as [string, number]);
  return `<div class="grid summary">
  <div><h2>${t('nationalitiesTitle')}</h2><p>${list(nationalities)}</p></div>
  <div><h2>${t('dietaryTitle')}</h2><p>${list(diets)}</p></div>
</div>`;
}

function warnings(d: DepartureCheckin, locale: DocLocale) {
  const t = translator(locale);
  const rows = d.parties.flatMap((party) =>
    party.guests.flatMap((g) =>
      g.warnings.map(
        (w) =>
          `<tr><td>${party.cabin ? ltr(party.cabin.number) : '—'}</td><td>${guestName(g)}</td><td>${t(w)}</td></tr>`,
      ),
    ),
  );
  return rows.length
    ? `<h2>${t('warningsTitle')}</h2><table><tbody>${rows.join('')}</tbody></table>`
    : '';
}

/** The reception desk's sheet: one row per cabin boarding, sorted by cabin. */
export function embarkationSheetHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
): string {
  const t = translator(locale);
  const p = textTranslator(locale);
  const withMoney = d.parties.some((x) => x.balance);
  const rows = d.parties
    .map(
      (party: CheckinParty) => `<tr>
<td class="cabin">${party.cabin ? ltr(party.cabin.number) : `<span class="muted">${t('notAssigned')}</span>`}<div class="muted small">${loc({ ar: party.category.nameAr, en: party.category.nameEn }, locale)}</div></td>
<td>${
        party.guests
          .map(
            (g) =>
              `<div>${guestName(g)} ${g.nationality ? `<span class="muted">${ltr(g.nationality)}</span>` : ''} ${tags(g, locale)}</div>`,
          )
          .join('') || '—'
      }</td>
<td>${ltr(party.ref)}<div class="muted small">${e(party.channel)}</div></td>
<td>${arrival(party.guests, locale)}</td>
${withMoney ? `<td class="num">${party.balance && party.balance.amount > 0n ? money(party.balance.amount, party.balance.currency, locale) : '—'}</td>` : ''}
<td class="c">${box(party.checkin.passportsSeen)}</td>
<td class="c">${box(party.checkin.cardsSigned)}</td>
<td class="c">${box(party.checkin.keyHanded)}</td>
<td class="notes"></td>
</tr>`,
    )
    .join('');
  const body = `<style>
.tick { display: inline-block; width: 14px; height: 14px; border: 1.5px solid var(--brand); border-radius: 3px; text-align: center; line-height: 12px; font-size: 10px; color: var(--brand-ink); }
.tick.on { background: var(--brand); }
td.c, th.c { text-align: center; }
td.cabin { font-weight: 700; font-size: 11pt; white-space: nowrap; }
td.notes { min-width: 28mm; }
.small { font-size: 8pt; }
.tag { display: inline-block; font-size: 7.5pt; padding: 0 5px; border-radius: 8px; margin-inline-start: 2px; }
.tag.diet { background: var(--accent-tint); color: var(--accent-text); }
.tag.occ { background: var(--brand-tint); color: var(--brand-text); }
.tag.warn { background: #fde4dc; color: #b42318; font-weight: 700; }
.summary p { margin: 0; }
.sign { display: flex; gap: 40px; margin-top: 22px; }
.sign div { flex: 1; border-top: 1px solid var(--ink); padding-top: 4px; font-size: 9pt; color: var(--muted); }
</style>
${headerFacts(d, locale)}
${summary(d, locale)}
<table style="margin-top:12px"><thead><tr>
<th>${t('cabin')}</th><th>${t('guests')}</th><th>${t('booking')}</th><th>${t('arrival')}</th>
${withMoney ? `<th class="num">${t('toCollect')}</th>` : ''}
<th class="c">${t('passportsSeen')}</th><th class="c">${t('cardSigned')}</th><th class="c">${t('keyHanded')}</th><th>${t('notes')}</th>
</tr></thead><tbody>${rows}</tbody></table>
${warnings(d, locale)}
<div class="sign"><div>${t('receptionist')}</div><div>${t('signature')}</div><div>${t('date')}</div></div>
<div class="meta">${p('allCheckedIn', { done: number(d.totals.checkedIn, locale), n: number(d.totals.cabins, locale) })} · ${p('issued')}: ${date(today(), locale, 'short')}</div>`;
  return page({
    locale,
    brand,
    title: p('embarkation_sheet'),
    heading: t('embarkation_sheet'),
    subtitle: date(d.leg.departDate, locale),
    body,
    landscape: true,
  });
}

/** The columns of the check-in file, shared by the PDF and the spreadsheet. */
export function checkinColumns(locale: DocLocale) {
  const p = textTranslator(locale);
  const v = (key: string | null) => (key ? p(key) : '');
  const d = (value: string | null) => value ?? '';
  return [
    { header: p('cabin'), width: 8, value: (party: CheckinParty) => party.cabin?.number ?? '' },
    { header: p('title'), width: 7, value: (_: CheckinParty, g: CheckinGuest) => v(g.title) },
    { header: p('lastName'), width: 16, value: (_: CheckinParty, g: CheckinGuest) => g.lastName },
    { header: p('firstName'), width: 16, value: (_: CheckinParty, g: CheckinGuest) => g.firstName },
    { header: p('gender'), width: 8, value: (_: CheckinParty, g: CheckinGuest) => v(g.gender) },
    {
      header: p('nationality'),
      width: 9,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.nationality),
    },
    { header: p('dob'), width: 11, value: (_: CheckinParty, g: CheckinGuest) => d(g.dateOfBirth) },
    {
      header: p('placeOfBirth'),
      width: 14,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.placeOfBirth),
    },
    {
      header: p('passport'),
      width: 13,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.passportNumber ?? null),
    },
    {
      header: p('passportCountry'),
      width: 9,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.passportCountry),
    },
    {
      header: p('passportIssuedOn'),
      width: 11,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.passportIssuedOn),
    },
    {
      header: p('passportExpiresOn'),
      width: 11,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.passportExpiresOn),
    },
    { header: p('visa'), width: 12, value: (_: CheckinParty, g: CheckinGuest) => v(g.visaType) },
    {
      header: p('visaNumber'),
      width: 13,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.visaNumber ?? null),
    },
    {
      header: p('arrival'),
      width: 11,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.arrivalDate),
    },
    {
      header: p('flight'),
      width: 9,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.arrivalFlight),
    },
    {
      header: p('entryPort'),
      width: 12,
      value: (_: CheckinParty, g: CheckinGuest) => d(g.arrivalPort),
    },
    { header: p('phone'), width: 14, value: (_: CheckinParty, g: CheckinGuest) => d(g.phone) },
    { header: p('booking'), width: 13, value: (party: CheckinParty) => party.ref },
  ];
}

/** Every guest boarding, one row each, in the order the police list asks for. */
export function checkinFileHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
): string {
  const t = translator(locale);
  const p = textTranslator(locale);
  const columns = checkinColumns(locale);
  const rows = d.parties.flatMap((party) =>
    party.guests.map(
      (g) =>
        `<tr>${columns
          .map((c) => {
            const value = c.value(party, g);
            return `<td>${/^[\w\d .,+:/-]*$/.test(value) ? ltr(value) : e(value)}</td>`;
          })
          .join('')}</tr>`,
    ),
  );
  const body = `<style>
table.wide th, table.wide td { font-size: 7.2pt; padding: 3px 4px; }
</style>
${headerFacts(d, locale)}
<div class="note alert">${t('confidential')}</div>
<table class="wide"><thead><tr>${columns.map((c) => `<th>${e(c.header)}</th>`).join('')}</tr></thead>
<tbody>${rows.join('')}</tbody></table>
<div class="meta">${p('totalGuests', { n: number(d.totals.guests, locale) })} · ${p('issued')}: ${date(today(), locale, 'short')}</div>`;
  return page({
    locale,
    brand,
    title: p('checkin_file'),
    heading: t('checkin_file'),
    subtitle: date(d.leg.departDate, locale),
    body,
    landscape: true,
  });
}

/** One card per guest, two to an A4 page, pre-filled; the guest checks and signs. */
export function registrationCardsHtml(
  d: DepartureCheckin,
  brand: DocumentBrand,
  locale: DocLocale,
): string {
  const t = translator(locale);
  const p = textTranslator(locale);
  const field = (label: string, value: string | null | undefined) =>
    `<div class="f"><span class="k">${t(label)}</span><span class="v">${value ? (/^[\w\d .,+:/-]*$/.test(value) ? ltr(value) : e(value)) : '&nbsp;'}</span></div>`;
  const day = (value: string | null) => (value ? date(value, locale, 'short') : null);
  const cards = d.parties.flatMap((party) =>
    party.guests.map(
      (g) => `<section class="card">
<div class="card-head">
  ${brand.logo ? `<img src="${e(brand.logo)}" alt="">` : ''}
  <div><div class="card-title">${t('cardTitle')}</div><div class="muted">${e(d.leg.vessel)} · ${date(d.leg.departDate, locale)}</div></div>
</div>
<div class="fields">
  ${field('lastName', g.lastName)}
  ${field('firstName', g.firstName)}
  ${field('nationality', g.nationality)}
  ${field('dob', day(g.dateOfBirth))}
  ${field('placeOfBirth', g.placeOfBirth)}
  ${field('gender', g.gender ? p(g.gender) : null)}
  ${field('passport', g.passportNumber)}
  ${field('passportCountry', g.passportCountry)}
  ${field('passportIssuedOn', day(g.passportIssuedOn))}
  ${field('passportExpiresOn', day(g.passportExpiresOn))}
  ${field('visa', g.visaType ? p(g.visaType) : null)}
  ${field('visaNumber', g.visaNumber)}
  ${field('phone', g.phone)}
  ${field('emergencyContact', [g.emergencyName, g.emergencyPhone].filter(Boolean).join(' · ') || null)}
  ${field('cabin', party.cabin?.number ?? null)}
  ${field('booking', party.ref)}
  ${field('disembark', day(party.disembark.date))}
</div>
<p class="decl">${t('declaration')}</p>
<div class="sign"><div>${t('guestSignature')}</div><div>${t('date')}</div></div>
</section>`,
    ),
  );
  const body = `<style>
.card { border: 1.5px solid var(--brand-line); border-radius: 10px; padding: 9mm 10mm 7mm; height: 128mm; break-inside: avoid; margin-bottom: 8mm; display: flex; flex-direction: column; }
.card:nth-of-type(2n) { break-after: page; }
.card-head { display: flex; align-items: center; gap: 10px; border-bottom: 3px solid var(--accent); padding-bottom: 6px; margin-bottom: 8px; }
.card-head img { max-height: 11mm; max-width: 30mm; }
.card-title { font-size: 12.5pt; font-weight: 700; color: var(--brand-text); }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }
.f { display: flex; gap: 8px; border-bottom: 1px dotted var(--rule); padding: 4px 0; }
.f .k { color: var(--muted); font-size: 8.5pt; min-width: 38%; }
.f .v { font-weight: 700; }
.decl { margin: 8px 0 0; font-size: 9pt; }
.sign { display: flex; gap: 30px; margin-top: auto; padding-top: 10mm; }
.sign div { flex: 1; border-top: 1px solid var(--ink); padding-top: 3px; font-size: 8.5pt; color: var(--muted); }
</style>
${cards.join('') || `<p class="muted">${t('none')}</p>`}`;
  return page({
    locale,
    brand,
    title: p('registration_cards'),
    heading: t('registration_cards'),
    subtitle: date(d.leg.departDate, locale),
    body,
    bare: true,
  });
}
