import type { DocumentBrand, InvoiceDocumentData } from '@vs/engine';
import { e, loc, ltr, page } from './html';
import { date, money, number, textTranslator, translator, type DocLocale } from './i18n';

/**
 * Invoices, proformas and credit notes (invoicing F2). One layout for all three: the company and
 * the party side by side, the document's number and dates, the lines with their tax, the totals,
 * then bank details, notes and the tax-authority footer. A draft carries a "not issued" band.
 */

/** Free text from the issuer (addresses, bank details): line breaks kept. */
const block = (value: string | null) => (value ? e(value).replace(/\n/g, '<br>') : '');

function pick(ar: string | null, en: string | null, locale: DocLocale): string {
  if (locale === 'ar') return block(ar || en);
  if (locale === 'en') return block(en || ar);
  if (ar && en && ar !== en)
    return `${block(ar)}<div class="en-block" dir="ltr">${block(en)}</div>`;
  return block(ar || en);
}

/** The file name base: the number, or the booking ref for a proforma. */
export function invoiceFileBase(d: InvoiceDocumentData): string {
  if (d.number) return d.number;
  const ref = d.bookingRefs[0] ?? d.id.slice(0, 8);
  return d.type === 'proforma' ? `proforma-${ref}` : `draft-invoice-${ref}`;
}

/** A timestamp's calendar date in Cairo. */
function cairoDate(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(value);
}

export function invoiceHtml(d: InvoiceDocumentData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const m = (amount: bigint) => money(amount, d.currency, locale);
  const pct = (bps: number) => number(bps / 100, locale);
  const issuer = d.issuer;
  const party = d.party;

  const issuerName = pick(issuer.legalNameAr, issuer.legalNameEn, locale) || e(issuer.name);
  const partyName = pick(party.legalNameAr, party.legalNameEn, locale) || e(party.name);
  const reg = (taxNo: string | null, crNo: string | null) =>
    [
      taxNo && `<div>${t('invTaxNo')}: ${ltr(taxNo)}</div>`,
      crNo && `<div>${t('invCrNo')}: ${ltr(crNo)}</div>`,
    ]
      .filter(Boolean)
      .join('');

  const parties = `<div class="parties">
  <div class="party"><div class="label">${t('invIssuer')}</div><div class="pname">${issuerName}</div>
    <div class="muted">${pick(issuer.addressAr, issuer.addressEn, locale)}</div>${reg(issuer.taxRegistrationNo, issuer.commercialRegistrationNo)}</div>
  <div class="party"><div class="label">${t('invBillTo')}</div><div class="pname">${partyName}</div>
    ${party.address ? `<div class="muted">${block(party.address)}</div>` : ''}${reg(party.taxRegistrationNo, party.commercialRegistrationNo)}
    ${[party.email && ltr(party.email), party.phone && ltr(party.phone)].filter(Boolean).join(' · ')}</div>
</div>`;

  const refs = d.bookingRefs.map(ltr).join(', ') || '—';
  const kv = (k: string, v: string) =>
    `<div class="kv"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  const facts = `<div class="facts">${
    d.type === 'proforma'
      ? kv(t('invProformaRef'), refs) + kv(t('date'), date(cairoDate(d.createdAt), locale, 'short'))
      : d.type === 'credit_note' && d.credits
        ? kv(t('invCreditNumber'), d.number ? ltr(d.number) : '—') +
          kv(t('invIssueDate'), d.issueDate ? date(d.issueDate, locale, 'short') : '—') +
          kv(t('invReason'), e(d.creditReason)) +
          kv(
            t('credit_note'),
            t('invCredits', {
              n: ltr(d.credits.number),
              d: date(d.credits.issueDate, locale, 'short'),
            }),
          )
        : kv(t('invNumber'), d.number ? ltr(d.number) : '—') +
          kv(t('invIssueDate'), d.issueDate ? date(d.issueDate, locale, 'short') : '—') +
          kv(t('invDueDate'), d.dueDate ? date(d.dueDate, locale, 'short') : '—') +
          kv(t('bookingRef'), refs)
  }</div>`;

  const anyTax = d.lines.some((l) => l.tax);
  const anyQty = d.lines.some((l) => l.quantity !== 1);
  const head = [
    `<th>#</th>`,
    `<th>${t('invDescription')}</th>`,
    anyQty ? `<th class="num">${t('invQty')}</th><th class="num">${t('invUnit')}</th>` : '',
    anyTax ? `<th class="num">${t('invTax')}</th>` : '',
    `<th class="num">${t('invAmount')}</th>`,
  ].join('');
  const rows = d.lines
    .map(
      (l, i) => `<tr>
<td class="num">${number(i + 1, locale)}</td>
<td>${loc(l.description, locale)}</td>
${anyQty ? `<td class="num">${number(l.quantity, locale)}</td><td class="num">${m(l.unitAmount)}</td>` : ''}
${anyTax ? `<td class="num">${l.tax ? `${pct(l.tax.bps)}%` : '—'}</td>` : ''}
<td class="num">${m(l.amount)}</td></tr>`,
    )
    .join('');
  const span = 2 + (anyQty ? 2 : 0) + (anyTax ? 1 : 0);
  const sumRow = (label: string, amount: bigint, cls = '') =>
    `<tr class="${cls}"><td colspan="${span}">${label}</td><td class="num">${m(amount)}</td></tr>`;
  const due = d.total - d.amountCredited - d.amountPaid;
  const totals = [
    anyTax ? sumRow(t('invSubtotal'), d.subtotal) : '',
    ...d.taxes.map((x) =>
      sumRow(t('invTaxLine', { name: loc(x.name, locale), p: pct(x.bps) }), x.tax),
    ),
    sumRow(t('invTotal'), d.total, 'total'),
    d.type === 'invoice' && d.amountCredited > 0n
      ? sumRow(t('invCredited'), -d.amountCredited)
      : '',
    d.type === 'invoice' && d.amountPaid > 0n ? sumRow(t('invPaid'), -d.amountPaid) : '',
    d.type === 'invoice' && (d.amountCredited > 0n || d.amountPaid > 0n)
      ? sumRow(t('invDue'), due > 0n ? due : 0n, 'total')
      : '',
  ].join('');

  const fx = d.fx
    ? `<p class="muted small">${t('invFx', {
        eq: ltr(`1 ${d.currency} = ${d.fx.rate} ${d.baseCurrency}`),
        s: e(d.fx.source ?? ''),
        d: d.fx.date ? date(d.fx.date, locale, 'short') : '',
        t: money(d.fx.baseTotal, d.baseCurrency, locale),
      })}</p>`
    : '';
  const bank =
    d.type !== 'credit_note' && (issuer.bankDetailsAr || issuer.bankDetailsEn)
      ? `<h2>${t('invBank')}</h2><div class="boxed">${pick(issuer.bankDetailsAr, issuer.bankDetailsEn, locale)}</div>`
      : '';
  const notes = [d.notes && block(d.notes), pick(issuer.noteAr, issuer.noteEn, locale)]
    .filter(Boolean)
    .map((n) => `<p>${n}</p>`)
    .join('');

  const draft = d.status === 'draft' && d.type !== 'proforma';
  const stamp =
    d.type === 'invoice' && d.status === 'cancelled'
      ? `<div class="note alert">${t('invFullyCredited')}</div>`
      : '';
  const body = `
<style>
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
.party { border: 1px solid var(--rule); border-radius: 8px; padding: 9px 11px; font-size: 9pt; }
.party .label { font-size: 8pt; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
.party .pname { font-size: 11pt; font-weight: 700; color: var(--brand-text); margin: 2px 0 3px; }
.en-block { font-family: 'Noto Sans', sans-serif; color: var(--muted); font-size: .9em; }
.lines { margin-top: 14px; }
.boxed { border: 1px solid var(--rule); border-radius: 8px; padding: 8px 11px; font-size: 9pt; }
.small { font-size: 8.5pt; }
.draft-band { text-align: center; font-weight: 700; color: #c2410c; border: 2px dashed #c2410c; border-radius: 6px; padding: 4px; margin-bottom: 10px; }
.eta { margin-top: 14px; font-size: 8pt; color: var(--muted); text-align: center; }
</style>
${draft ? `<div class="draft-band">${t('invDraft')}</div>` : ''}
${stamp}
${parties}
${facts}
<table class="lines"><thead><tr>${head}</tr></thead><tbody>${rows}${totals}</tbody></table>
${fx}
${d.type === 'proforma' ? `<div class="note">${t('invProformaNote')}</div>` : ''}
${bank}
${notes ? `<h2>${t('invNotes')}</h2>${notes}` : ''}
${issuer.etaFooter ? `<div class="eta">${t('invEta')}</div>` : ''}`;

  const title = p(d.type);
  return page({
    locale,
    brand,
    title: d.number ? `${title} ${d.number}` : title,
    heading: t(d.type),
    subtitle: d.number ? ltr(d.number) : d.bookingRefs.map(ltr).join(', '),
    body,
  });
}
