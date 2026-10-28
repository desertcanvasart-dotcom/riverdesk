import type { DocumentBrand, StatementData } from '@vs/engine';
import { e, ltr, page } from './html';
import { date, money, textTranslator, translator, type DocLocale } from './i18n';

/**
 * A party's statement of account (invoicing F4): per currency, the opening balance, every
 * invoice, credit note, payment and refund in the period with a running balance, the closing
 * balance, and today's open invoices and unapplied money.
 */

const pick = (ar: string | null, en: string | null, locale: DocLocale) =>
  e(locale === 'en' ? en || ar : ar || en);

export function statementFileBase(d: StatementData): string {
  const name = d.party.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'party';
  return `statement-${name}-${d.from}-${d.to}`;
}

export function statementHtml(d: StatementData, brand: DocumentBrand, locale: DocLocale) {
  const t = translator(locale);
  const p = textTranslator(locale);
  const day = (value: string) => date(value, locale, 'short');
  const issuerName = pick(d.issuer.legalNameAr, d.issuer.legalNameEn, locale) || e(d.issuer.name);
  const partyName = pick(d.party.legalNameAr, d.party.legalNameEn, locale) || e(d.party.name);
  const kindLabel = (kind: string) =>
    kind === 'invoice' || kind === 'credit_note'
      ? t(kind)
      : t(`stKind_${kind}` as 'stKind_receipt');

  const sections = d.currencies
    .map((c) => {
      const m = (amount: bigint) => money(amount, c.currency, locale);
      const rows = c.rows
        .map(
          (r) => `<tr>
<td>${day(r.date)}</td>
<td>${kindLabel(r.kind)}</td>
<td>${ltr(r.reference)}${r.dueDate ? `<div class="muted small">${t('invDueDate')}: ${day(r.dueDate)}</div>` : ''}</td>
<td class="num">${r.debit ? m(r.debit) : ''}</td>
<td class="num">${r.credit ? m(r.credit) : ''}</td>
<td class="num">${m(r.balance)}</td></tr>`,
        )
        .join('');
      return `<h2>${t('stCurrency', { c: ltr(c.currency) })}</h2>
<table class="lines"><thead><tr>
<th>${t('stDate')}</th><th>${t('stDocument')}</th><th></th>
<th class="num">${t('stDebit')}</th><th class="num">${t('stCredit')}</th><th class="num">${t('stBalance')}</th>
</tr></thead><tbody>
<tr class="sum"><td colspan="5">${t('stOpening')} (${day(d.from)})</td><td class="num">${m(c.opening)}</td></tr>
${rows || `<tr><td colspan="6" class="muted">${t('stNone')}</td></tr>`}
<tr class="total"><td colspan="5">${t('stClosing')} (${day(d.to)})</td><td class="num">${m(c.closing)}</td></tr>
</tbody></table>
<p class="muted small">${t('stOpenInvoices')}: ${m(c.openInvoices)} · ${t('stUnapplied')}: ${m(c.unappliedCredit)}</p>`;
    })
    .join('');

  const body = `
<style>
.parties { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 12px; }
.party { border: 1px solid var(--rule); border-radius: 8px; padding: 9px 11px; font-size: 9pt; }
.party .label { font-size: 8pt; color: var(--muted); text-transform: uppercase; }
.party .pname { font-size: 11pt; font-weight: 700; color: var(--brand-text); margin: 2px 0 3px; }
.small { font-size: 8.5pt; }
tr.sum td { color: var(--muted); }
</style>
<div class="parties">
  <div class="party"><div class="label">${t('invIssuer')}</div><div class="pname">${issuerName}</div>
    ${d.issuer.taxRegistrationNo ? `<div>${t('invTaxNo')}: ${ltr(d.issuer.taxRegistrationNo)}</div>` : ''}</div>
  <div class="party"><div class="label">${t('invBillTo')}</div><div class="pname">${partyName}</div>
    ${d.party.address ? `<div class="muted">${e(d.party.address)}</div>` : ''}
    ${d.party.taxRegistrationNo ? `<div>${t('invTaxNo')}: ${ltr(d.party.taxRegistrationNo)}</div>` : ''}</div>
</div>
${sections || `<p class="muted">${t('stNone')}</p>`}
<p class="muted small">${t('stSigns')}</p>
${d.issuer.etaFooter ? `<p class="muted small" style="text-align:center">${t('invEta')}</p>` : ''}`;

  return page({
    locale,
    brand,
    title: `${p('statement')} ${d.party.name}`,
    heading: t('statement'),
    subtitle: t('stPeriod', { f: day(d.from), t: day(d.to) }),
    body,
  });
}
