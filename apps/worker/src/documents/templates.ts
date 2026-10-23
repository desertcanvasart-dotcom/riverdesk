import type { BookingDocumentData, LegManifest, VacancyData } from '@vs/engine';
import { e, ltr, page } from './html';
import { date, money, number, today, translator, type Locale } from './i18n';

/** HTML for each document kind. Prices are left out of the agency copy. */

type Kind = 'voucher' | 'itinerary' | 'payment_schedule' | 'cancellation_terms';

function bookingHeader(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  // The itinerary name already says how many nights; without one, the nights stand in for it.
  const name = d.sailing.name
    ? e(d.sailing.name[locale])
    : `${number(d.sailing.nights, locale)} ${t('nights')}`;
  return `
<div class="grid">
  <div class="kv"><span class="k">${t('bookingRef')}</span><span class="v">${ltr(d.booking.ref)}</span></div>
  ${d.booking.channelRef ? `<div class="kv"><span class="k">${t('agencyRef')}</span><span class="v">${ltr(d.booking.channelRef)}</span></div>` : `<div class="kv"><span class="k">${t('bookedBy')}</span><span class="v">${e(d.booking.channel)}</span></div>`}
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('cruise')}</span><span class="v">${name}</span></div>
  <div class="kv"><span class="k">${t('embark')}</span><span class="v">${date(d.sailing.embark.date, locale)} · ${e(d.sailing.embark.port[locale])}${d.sailing.embark.time ? ` · ${ltr(d.sailing.embark.time)}` : ''}</span></div>
  <div class="kv"><span class="k">${t('disembark')}</span><span class="v">${date(d.sailing.disembark.date, locale)} · ${e(d.sailing.disembark.port[locale])}${d.sailing.disembark.time ? ` · ${ltr(d.sailing.disembark.time)}` : ''}</span></div>
</div>`;
}

function footer(d: BookingDocumentData, locale: Locale, agency: boolean) {
  const t = translator(locale);
  return `<footer>${agency ? `${t('agencyCopy')} · ` : ''}${t('issued')}: ${date(today(), locale, 'short')}${
    d.operator.emergencyPhone ? ` · ${t('emergency')}: ${ltr(d.operator.emergencyPhone)}` : ''
  }</footer>`;
}

function cabinsTable(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  return `<h2>${t('cabins')}</h2>
<table><thead><tr><th>${t('cabin')}</th><th>${t('category')}</th><th>${t('guests')}</th><th>${t('adults')}</th><th>${t('children')}</th></tr></thead><tbody>
${d.cabins
  .map(
    (
      c,
    ) => `<tr><td>${c.cabinNumber ? ltr(c.cabinNumber) : `<span class="muted">${t('notAssigned')}</span>`}</td>
<td>${e(c.category[locale])}</td>
<td>${c.guests.map((g) => `${e(g.name)}${g.lead ? ` <span class="muted">(${t('lead')})</span>` : ''}`).join('<br>') || '—'}</td>
<td class="num">${number(c.adults, locale)}</td>
<td>${c.childAges.length ? c.childAges.map((a) => number(a, locale)).join('، ') : '—'}</td></tr>`,
  )
  .join('')}
</tbody></table>`;
}

function itineraryTable(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  const time = (value: string | null) => (value ? ` ${ltr(value)}` : '');
  return `<table><thead><tr><th>${t('day', { n: '' }).trim()}</th><th>${t('date')}</th><th>${t('ports')}</th></tr></thead><tbody>
${d.days
  .map(
    (day) =>
      `<tr><td>${t('day', { n: number(day.day, locale) })}</td><td>${date(day.date, locale)}</td><td>${day.stops
        .map(
          (s) =>
            `${e(s.port[locale])}${time(s.arrive)}${s.depart && s.depart !== s.arrive ? ` –${time(s.depart)}` : ''}`,
        )
        .join(' · ')}</td></tr>`,
  )
  .join('')}
</tbody></table>`;
}

function cancellationTable(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  const rules = d.cancellation;
  return `<p>${t('cancellationIntro')}</p>
<table><tbody>
${rules
  .map((r, i) => {
    const label =
      i === rules.length - 1 && r.fromDays === 0
        ? t('lessThan', { n: number(rules[i - 1]?.fromDays ?? 0, locale) })
        : t('daysOrMore', { n: number(r.fromDays, locale) });
    return `<tr><td>${label}</td><td class="num">${t('penalty', { p: number(r.penaltyBps / 100, locale) })}</td></tr>`;
  })
  .join('')}
</tbody></table>`;
}

function totalsTable(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  const m = (amount: bigint) => money(amount, d.booking.currency, locale);
  const balance = d.booking.total + d.booking.fees - d.booking.amountPaid;
  return `<table><tbody>
<tr><td>${t('total')}</td><td class="num">${m(d.booking.total)}</td></tr>
${d.booking.fees > 0n ? `<tr><td>${t('fees')}</td><td class="num">${m(d.booking.fees)}</td></tr>` : ''}
<tr><td>${t('paid')}</td><td class="num">${m(d.booking.amountPaid)}</td></tr>
<tr class="total"><td>${t('balance')}</td><td class="num">${m(balance > 0n ? balance : 0n)}</td></tr>
</tbody></table>`;
}

function paymentsTables(d: BookingDocumentData, locale: Locale) {
  const t = translator(locale);
  const m = (amount: bigint, currency = d.booking.currency) => money(amount, currency, locale);
  return `${totalsTable(d, locale)}
${
  d.paymentsDue.length
    ? `<h2>${t('dueNow')}</h2><table><tbody>${d.paymentsDue
        .map(
          (p) =>
            `<tr><td>${p.kind === 'deposit' ? t('deposit') : t('balanceKind')}</td><td>${t('due')} ${date(p.dueDate, locale)}</td><td class="num">${m(p.amount)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : ''
}
<h2>${t('received')}</h2>
${
  d.payments.length
    ? `<table><thead><tr><th>${t('receivedOn')}</th><th>${t('method')}</th><th>${t('reference')}</th><th class="num">${t('amount')}</th></tr></thead><tbody>${d.payments
        .map(
          (p) =>
            `<tr><td>${date(p.receivedOn, locale, 'short')}</td><td>${t(p.kind === 'refund' ? 'refund' : p.method)}</td><td>${ltr(p.reference)}</td><td class="num">${m(p.amount, p.currency)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p class="muted">${t('noPayments')}</p>`
}`;
}

export function bookingDocumentHtml(
  kind: Kind,
  d: BookingDocumentData,
  locale: Locale,
  agency: boolean,
): string {
  const t = translator(locale);
  let body = bookingHeader(d, locale);
  if (kind === 'voucher') {
    body += cabinsTable(d, locale);
    body += `<div class="grid" style="margin-top:12px">
<div><h2>${t('inclusions')}</h2><ul class="list">${(d.inclusions[locale] ?? []).map((x) => `<li>${e(x)}</li>`).join('')}<li>${t('board')}: ${t(d.board)}</li></ul></div>
<div><h2>${t('exclusions')}</h2><ul class="list">${(d.exclusions[locale] ?? []).map((x) => `<li>${e(x)}</li>`).join('')}</ul></div>
</div>`;
    if (d.needsResidencyProof) body += `<div class="note">${t('residencyNote')}</div>`;
    if (d.operator.voucherNote[locale])
      body += `<div class="note">${e(d.operator.voucherNote[locale]).replace(/\n/g, '<br>')}</div>`;
    if (!agency) body += `<h2>${t('total')}</h2>${totalsTable(d, locale)}`;
    body += `<h2>${t('itinerary')}</h2>${itineraryTable(d, locale)}`;
  } else if (kind === 'itinerary') {
    body += `<h2>${t('itinerary')}</h2>${itineraryTable(d, locale)}`;
  } else if (kind === 'payment_schedule') {
    body += `<h2>${t('payment_schedule')}</h2>${agency ? '' : paymentsTables(d, locale)}`;
  } else {
    body += `<h2>${t('cancellation_terms')}</h2>${cancellationTable(d, locale)}`;
  }
  body += footer(d, locale, agency);
  return page({
    locale,
    title: t(kind),
    operator: d.operator.name,
    subtitle: ltr(d.booking.ref),
    body,
  });
}

export function manifestHtml(
  m: LegManifest,
  operator: string,
  locale: Locale,
  withPassports: boolean,
): string {
  const t = translator(locale);
  const rows = m.parties.flatMap((p) =>
    p.guests.map(
      (g, i) => `<tr>
<td>${i === 0 ? (p.cabin ? ltr(p.cabin.number) : `<span class="muted">${t('notAssigned')}</span>`) : ''}</td>
<td>${i === 0 ? e(locale === 'ar' ? p.category.nameAr : p.category.nameEn) : ''}</td>
<td>${e(`${g.lastName}, ${g.firstName}`)}</td>
<td>${ltr(g.nationality ?? '—')}</td>
<td>${g.dateOfBirth ? date(g.dateOfBirth, locale, 'short') : '—'}</td>
${withPassports ? `<td>${ltr(g.passportNumber ?? '—')}</td>` : ''}
<td>${ltr(p.ref)}</td>
<td>${ltr(`${p.embark.port} → ${p.disembark.port}`)}</td>
</tr>`,
    ),
  );
  const guests = m.parties.reduce((n, p) => n + p.guests.length, 0);
  const body = `
<div class="grid">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(m.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departure')}</span><span class="v">${date(m.leg.departDate, locale)}</span></div>
  <div class="kv"><span class="k">${t('from')}</span><span class="v">${e(locale === 'ar' ? m.leg.from.nameAr : m.leg.from.nameEn)}</span></div>
  <div class="kv"><span class="k">${t('to')}</span><span class="v">${e(locale === 'ar' ? m.leg.to.nameAr : m.leg.to.nameEn)}</span></div>
</div>
${withPassports ? `<div class="note">${t('confidential')}</div>` : ''}
<table style="margin-top:10px"><thead><tr>
<th>${t('cabin')}</th><th>${t('category')}</th><th>${t('name')}</th><th>${t('nationality')}</th><th>${t('dob')}</th>
${withPassports ? `<th>${t('passport')}</th>` : ''}<th>${t('booking')}</th><th>${t('cruise')}</th>
</tr></thead><tbody>${rows.join('')}</tbody></table>
<footer>${t('totalGuests', { n: number(guests, locale) })} · ${t('issued')}: ${date(today(), locale, 'short')}</footer>`;
  return page({
    locale,
    title: t('manifest'),
    operator,
    subtitle: date(m.leg.departDate, locale),
    body,
    landscape: true,
  });
}

export function roomingHtml(m: LegManifest, operator: string, locale: Locale): string {
  const t = translator(locale);
  const body = `
<div class="grid">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(m.leg.vessel)}</span></div>
  <div class="kv"><span class="k">${t('departure')}</span><span class="v">${date(m.leg.departDate, locale)} · ${e(locale === 'ar' ? m.leg.from.nameAr : m.leg.from.nameEn)}</span></div>
</div>
<table style="margin-top:10px"><thead><tr>
<th>${t('cabin')}</th><th>${t('category')}</th><th>${t('guests')}</th><th class="num">${t('adults')}</th><th>${t('children')}</th><th>${t('booking')}</th><th>${t('bookedBy')}</th>
</tr></thead><tbody>
${m.parties
  .map(
    (
      p,
    ) => `<tr><td>${p.cabin ? ltr(p.cabin.number) : `<span class="muted">${t('notAssigned')}</span>`}</td>
<td>${e(locale === 'ar' ? p.category.nameAr : p.category.nameEn)}</td>
<td>${p.guests.map((g) => e(`${g.firstName} ${g.lastName}`)).join('<br>') || '—'}</td>
<td class="num">${number(p.adults, locale)}</td>
<td>${p.childAges.length ? p.childAges.map((a) => number(a, locale)).join('، ') : '—'}</td>
<td>${ltr(p.ref)}</td><td>${e(p.channel)}</td></tr>`,
  )
  .join('')}
</tbody></table>
<footer>${t('issued')}: ${date(today(), locale, 'short')}</footer>`;
  return page({
    locale,
    title: t('rooming_list'),
    operator,
    subtitle: date(m.leg.departDate, locale),
    body,
    landscape: true,
  });
}

export function vacancyHtml(v: VacancyData, locale: Locale): string {
  const t = translator(locale);
  const body = `
<p class="muted">${e(v.vessel)} · ${date(v.from, locale, 'short')} – ${date(v.to, locale, 'short')}</p>
<table><thead><tr><th>${t('embark')}</th><th>${t('cruise')}</th>${v.categories
    .map(
      (c) =>
        `<th class="num">${e(c.code)}<br><span class="muted">${e(locale === 'ar' ? c.ar : c.en)}</span></th>`,
    )
    .join('')}</tr></thead><tbody>
${v.sailings
  .map(
    (s) => `<tr><td>${date(s.embarkDate, locale, 'short')}</td>
<td>${t('sailFrom', { from: e(s.embark[locale]), to: e(s.disembark[locale]) })} · ${number(s.nights, locale)} ${t('nights')}</td>
${v.categories
  .map((c) => {
    const free = s.free[c.id] ?? 0;
    return `<td class="num" style="${free === 0 ? 'color:#b42318' : free <= 2 ? 'color:#a15c00' : 'color:#1f7a3d'};font-weight:700">${number(free, locale)}</td>`;
  })
  .join('')}</tr>`,
  )
  .join('')}
</tbody></table>
<footer>${t('free')} · ${t('issued')}: ${date(today(), locale, 'short')}</footer>`;
  return page({ locale, title: t('vacancy_sheet'), operator: v.operator, body, landscape: true });
}
