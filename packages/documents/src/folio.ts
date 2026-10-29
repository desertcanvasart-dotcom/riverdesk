import type { DocumentBrand, FolioShiftReportData, GuestFolioData } from '@vs/engine';
import { e, loc, ltr, page } from './html';
import { date, money, number, textTranslator, translator, type DocLocale } from './i18n';

/**
 * Extras on board (Batch E2): the guest's folio — every charge still standing, by day, the
 * invoice it was closed into and what was paid at reception — and the purser's shift report for
 * one vessel and day.
 */

export function guestFolioHtml(d: GuestFolioData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const m = (amount: bigint) => money(amount, d.currency, locale);
  const rows = d.charges
    .map(
      (c) => `<tr>
<td>${date(c.chargedOn, locale, 'short')}</td>
<td>${loc({ ar: c.descriptionAr, en: c.descriptionEn }, locale)}${c.guestName ? `<div class="muted small">${e(c.guestName)}</div>` : ''}</td>
<td class="num">${number(c.quantity, locale)}</td>
<td class="num">${m(c.unitAmount)}</td>
<td class="num">${m(c.amount)}</td></tr>`,
    )
    .join('');
  const sum = (label: string, amount: bigint, cls = '') =>
    `<tr class="${cls}"><td colspan="4">${label}</td><td class="num">${m(amount)}</td></tr>`;
  const inv = d.invoice;
  const totals = inv
    ? [
        inv.taxTotal !== 0n ? sum(t('foSubtotal'), inv.subtotal) : '',
        inv.taxTotal !== 0n ? sum(t('foTax'), inv.taxTotal) : '',
        sum(t('foTotal'), inv.total, 'total'),
        ...inv.payments.map((x) =>
          sum(
            `${t('foPaid')} · ${t(`fo_method_${x.method}`)} · ${date(x.receivedOn, locale, 'short')}${
              x.currency !== d.currency ? ` (${ltr(money(x.amount, x.currency, locale))})` : ''
            }`,
            -x.invoiceAmount,
          ),
        ),
        d.billTo === 'guest' ? sum(t('foBalance'), inv.balance, 'total') : '',
      ].join('')
    : sum(t('foTotal'), d.total, 'total');
  const categories = Object.entries(d.byCategory)
    .map(([k, v]) => `${t(`fo_cat_${k}`)} <b>${m(v)}</b>`)
    .join(' · ');
  const body = `<style>
tr.total td { font-weight: 700; border-top: 1px solid var(--ink); }
.sign { display: flex; gap: 40px; margin-top: 26px; }
.sign div { flex: 1; border-top: 1px solid var(--ink); padding-top: 4px; font-size: 9pt; color: var(--muted); }
</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('foCabin')}</span><span class="v">${d.cabin ? ltr(d.cabin) : '—'}</span></div>
  <div class="kv"><span class="k">${t('foGuests')}</span><span class="v">${d.guests.map(e).join('، ') || '—'}</span></div>
  <div class="kv"><span class="k">${t('foBooking')}</span><span class="v">${ltr(d.ref)}</span></div>
  <div class="kv"><span class="k">${t('foCruise')}</span><span class="v">${date(d.embark.date, locale, 'short')} ${loc({ ar: d.embark.port.nameAr, en: d.embark.port.nameEn }, locale)} → ${date(d.disembark.date, locale, 'short')} ${loc({ ar: d.disembark.port.nameAr, en: d.disembark.port.nameEn }, locale)}</span></div>
  <div class="kv"><span class="k">${t('foInvoice')}</span><span class="v">${inv ? `${ltr(inv.number)} · ${date(inv.issueDate, locale, 'short')}` : t('foOpen')}</span></div>
</div>
${d.billTo === 'agency' && d.agency ? `<p><b>${t('foAgency', { name: e(d.agency) })}</b></p>` : ''}
${
  d.charges.length
    ? `<table><thead><tr><th>${t('foDate')}</th><th>${t('foItem')}</th><th class="num">${t('foQty')}</th><th class="num">${t('foUnit')}</th><th class="num">${t('foAmount')}</th></tr></thead>
<tbody>${rows}${totals}</tbody></table>
<p class="muted small">${categories}</p>`
    : `<p>${t('foNothing')}</p>`
}
<div class="sign"><div>${t('foSignature')}</div><div>${t('foReception')}</div></div>`;
  return page({
    locale,
    brand,
    title: `${p('guest_folio')} ${d.cabin ?? d.ref}`,
    heading: t('guest_folio'),
    subtitle: `${e(d.vessel)} · ${t('foCabin')} ${d.cabin ? ltr(d.cabin) : ltr(d.ref)}`,
    body,
  });
}

export function folioShiftReportHtml(
  d: FolioShiftReportData,
  brand: DocumentBrand,
  locale: DocLocale,
) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const m = (amount: bigint, currency = d.currency) => money(amount, currency, locale);
  const time = (at: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  const categories = d.byCategory
    .map(
      (c) =>
        `<tr><td>${t(`fo_cat_${c.category}`)}</td><td class="num">${number(c.charges, locale)}</td><td class="num">${m(c.amount)}</td></tr>`,
    )
    .join('');
  const voids = d.voids
    .map(
      (v) =>
        `<tr><td>${v.cabin ? ltr(v.cabin) : '—'}</td><td>${e(v.description)}</td><td class="num">${m(v.amount)}</td><td>${e(v.reason)}</td><td>${v.by ? e(v.by) : ''}</td></tr>`,
    )
    .join('');
  const payments = d.payments
    .map(
      (x) =>
        `<tr><td>${ltr(time(x.at))}</td><td>${x.cabin ? ltr(x.cabin) : '—'}</td><td>${ltr(x.invoice)}</td><td>${t(`fo_method_${x.method}`)}</td><td class="num">${m(x.amount, x.currency)}</td><td>${x.by ? e(x.by) : ''}</td></tr>`,
    )
    .join('');
  const takings = d.takings
    .map((x) => `${t(`fo_method_${x.method}`)} <b>${m(x.amount, x.currency)}</b>`)
    .join(' · ');
  const body = `<style>
tr.total td { font-weight: 700; border-top: 1px solid var(--ink); }
.sign { display: flex; gap: 40px; margin-top: 26px; }
.sign div { flex: 1; border-top: 1px solid var(--ink); padding-top: 4px; font-size: 9pt; color: var(--muted); }
</style>
<div class="facts">
  <div class="kv"><span class="k">${t('vessel')}</span><span class="v">${e(d.vessel)}</span></div>
  <div class="kv"><span class="k">${t('foDate')}</span><span class="v">${date(d.date, locale)}</span></div>
  <div class="kv"><span class="k">${t('srClosed')}</span><span class="v">${number(d.closed.count, locale)} · ${m(d.closed.total)}${d.closed.toAgency ? ` <span class="muted">(${t('srToAgency', { n: number(d.closed.toAgency, locale) })})</span>` : ''}</span></div>
  <div class="kv"><span class="k">${t('srOpen')}</span><span class="v">${number(d.open.count, locale)} · ${m(d.open.total)}</span></div>
</div>
<h2>${t('srCharged')}</h2>
${
  d.byCategory.length
    ? `<table><thead><tr><th>${t('foItem')}</th><th class="num">${t('srCharges')}</th><th class="num">${t('foAmount')}</th></tr></thead>
<tbody>${categories}<tr class="total"><td colspan="2">${t('foTotal')}</td><td class="num">${m(d.charged)}</td></tr></tbody></table>`
    : `<p class="muted">${t('foNothing')}</p>`
}
${
  d.voids.length
    ? `<h2>${t('srVoids')}</h2><table><thead><tr><th>${t('foCabin')}</th><th>${t('foItem')}</th><th class="num">${t('foAmount')}</th><th>${t('srReason')}</th><th>${t('srBy')}</th></tr></thead><tbody>${voids}</tbody></table>`
    : ''
}
<h2>${t('srPayments')}</h2>
${
  d.payments.length
    ? `<table><thead><tr><th>${t('srTime')}</th><th>${t('foCabin')}</th><th>${t('foInvoice')}</th><th>${t('srMethod')}</th><th class="num">${t('foAmount')}</th><th>${t('srBy')}</th></tr></thead><tbody>${payments}</tbody></table>
<p>${t('srTakings')}: ${takings}</p>`
    : `<p class="muted">${t('srNoPayments')}</p>`
}
<div class="sign"><div>${t('srHandedBy')}</div><div>${t('srReceivedBy')}</div></div>`;
  return page({
    locale,
    brand,
    title: `${p('folio_shift_report')} ${d.date}`,
    heading: t('folio_shift_report'),
    subtitle: `${e(d.vessel)} · ${date(d.date, locale)}`,
    body,
  });
}
