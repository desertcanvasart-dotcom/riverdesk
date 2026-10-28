# Invoices, payments and receivables — Phase 0 plan

Status: **building — F1 and F2 done (2026-10-26), F3 and F4 done (2026-10-29), F5 next.** The owner asked to keep building without
answering § 8 one by one, so the recommended answers below were taken; any can still be changed
before the batch that uses it. Agreed order: see `analytics-plan.md` § Roadmap.

Answers taken (§ 8):

1. Who is billed: `credit` and `channel_collected` contracts → the agency or platform; direct
   (back-office) bookings and `vessel_prepaid` bookings made through an agency → the guest, who
   pays the vessel.
2. Agency invoices on commission contracts: the gross price with the commission as its own line
   deducted, so the journal can post commission to its own account.
3. Credit limit: stays on the channel (one exposure per agency). Each contract gets a mode; the
   default is `block`, which keeps today's behaviour (the booking becomes a request for approval);
   `warn` is available per contract.
4. Exposure: uninvoiced confirmed bookings + open invoices − unapplied credit.
5. Existing bookings: invoicing starts from go-live, no back-dated invoices; the first number of
   each series is configurable for operators continuing a paper series.
6. Base currency EGP by default (per company); rates typed in with their source and date.
7. Taxes: none by default; a company adds its own lines (e.g. 14% VAT, inclusive).
8. Sharing: the phone's share sheet with the PDF, plus an in-app link; no public link.
9. Cancelled bookings: invoice only the penalty and the fees kept; an earlier invoice is credited
   in full.
10. Payment methods: the § 6 mapping; "collected by the platform" stays a method of its own.
11. Proformas: «فاتورة مبدئية» / "Proforma", referenced by the booking reference.
12. Numbers in words: left out of the first version.
13. Channel API invoice endpoints: left out of this phase.
14. Receipt attachments: in Postgres, up to 5 MB, like documents.
15. Batches F1–F6 as listed, each stopping for review.

## 1. What exists and will be reused

| Area             | What is there                                                                                                                                                                                                                                                                                 | How invoicing uses it                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Money            | `packages/shared/src/money.ts`: bigint minor units + ISO code, `mulDivHalfUp` (half away from zero), `convert(amount, rate, to)` with decimal-string rates (≤ 6 places), `percentOf(bps)`. Rule 10: no floats.                                                                                | All invoice, tax and allocation amounts. Same rounding, once per line.                                                                                               |
| Prices           | `computePrice` (`engine/pricing/compute.ts`) builds per-cabin lines; the contract's markup is a line in the total, commission is an information line, `netTotal = total − commission`. The quote stores the lines, frozen; the booking stores `total`, `net_total`, `fees`, `penalty_amount`. | Invoice lines are **copied from the booking's frozen quote lines**, not re-priced. Re-running the price calculation would change old invoices whenever rates change. |
| Payment ledger   | `vs.payment`, append-only, per booking: receipts, refunds, reversals, other-currency amounts with the rate and the booking-currency amount. `recordPayment` also confirms held prepaid bookings; `refreshPaymentStatus`, refunds, overdue job.                                                | Stays the **booking-level** ledger, unchanged in behaviour. New receipts and allocations sit above it (see § 3.4).                                                   |
| Payment schedule | Deposit and balance due date on `vs.booking` (from the quote's policy snapshot). No schedule table.                                                                                                                                                                                           | Default due date of a direct guest's invoice = the booking's balance due date. Nothing to migrate.                                                                   |
| Credit           | `channel.credit_allowed / credit_limit / credit_currency`; `exceedsCredit` locks the channel row and sums `total + fees − paid` over confirmed bookings; over the limit the booking becomes a **request** for staff approval (spec § Credit rules).                                           | Extended to count open invoices and unapplied credit; warn/block per § 3.7.                                                                                          |
| Documents        | `vs.document` + `requestDocument` + worker (Playwright Chromium → PDF, ExcelJS → xlsx), A4, embedded Noto fonts, RTL, `ar` / `en`, bytes stored in Postgres, downloaded through an authenticated route.                                                                                       | New kinds `invoice`, `credit_note`, `statement`, `aging`, reports, `accountant_export`.                                                                              |
| Roles            | `owner`, `reservations`, `finance`, `read_only`; `PERMISSIONS` map; `procedure(permission)`; MFA (aal2) required for owner and finance.                                                                                                                                                       | New `finance` permission (owner + finance); proformas for reservations.                                                                                              |
| Audit            | `audit(tx, operatorId, actor, {action, entity, entityId, before, after})`, diff `{field: {from, to}}`, redaction.                                                                                                                                                                             | Every issue, credit, receipt, allocation and settings change.                                                                                                        |
| Today            | `getActionList` (fixed SQL queries) + `sections` in the Today page.                                                                                                                                                                                                                           | Four new sections.                                                                                                                                                   |
| Tests            | `checkTenantIsolation` discovers every tenant table and requires a fixture; `demoWorld` / `bookingWorld`; `concurrency.test.ts` `tally()` pattern.                                                                                                                                            | New tables get fixtures automatically checked; the numbering race test follows the overbooking test.                                                                 |

## 2. What is missing

- **Issuer details:** no legal name (AR/EN), address, tax or commercial registration, logo, bank details, base currency.
- **Billing parties:** guests exist only inside bookings; agencies are `channel` rows with a name only. No legal name, address or registration numbers.
- **Taxes, numbering, invoices, credit notes, receipts, allocations, account mapping:** none.
- **Bilingual (`both`) documents:** document locale is `ar` or `en` only.
- **Sharing:** no share link; the only outbound copy is the outage-pack email.
- **Channel API scopes:** API clients have none.
- **Receivables views:** exposure is computed only inside the credit check; no statement, aging or report.

## 3. Proposed data model

All tables in schema `vs`, with `operator_id`, RLS `tenant_isolation`, owned by `vs_owner`, a
`TENANT_FIXTURES` entry, and composite foreign keys `(operator_id, id)` like every existing table.
Money columns are `bigint` minor units with a `char(3)` currency.

### 3.1 Settings

**`finance_setting`** (one row per company)

- `legal_name_ar`, `legal_name_en`, `address_ar`, `address_en`, `tax_registration_no`, `commercial_registration_no`, `phone`, `email`
- `logo` (bytea ≤ 200 KB, PNG/JPEG) and `logo_type` — embedded in PDFs as a `data:` URL, since the renderer blocks the network
- `bank_details_ar`, `bank_details_en` (free text block)
- `base_currency` (default `EGP`), `invoice_currencies char(3)[]` (default `{EUR,USD,EGP}`)
- `invoice_prefix` (default `INV`), `credit_note_prefix` (default `CN`), `number_digits` (default 5)
- `eta_footer` (boolean, default true): «مستند تجاري — ليس فاتورة إلكترونية معتمدة من مصلحة الضرائب»
- `default_terms_days` (for manual invoices), `invoice_note_ar`, `invoice_note_en`
- ETA, nullable: `eta_activity_code`, `eta_branch_id`

**`tax_rate`**: `name_ar`, `name_en`, `rate_bps`, `inclusive` (boolean), `active`, `sort_order`. Default: no rows, so no tax.

**`account_mapping`**: `kind` (`revenue_vessel`, `revenue_channel`, `tax_payable`, `receivables`, `cash`, `bank`, `commission`), `ref_id` (vessel, channel or tax rate, nullable), `code`. Unique per `(kind, ref_id)`. Blank by default.

**`channel_contract`** gains `credit_terms_days` (due date = issue date + N), `credit_limit_mode` (`warn` | `block`), `contract_ref`.

### 3.2 Billing parties

**`billing_party`**

- `kind` (`agency` | `guest`) and `channel_id` (for agencies; unique per channel)
- `name`, `legal_name_ar`, `legal_name_en`, `address`, `tax_registration_no`, `commercial_registration_no`, `email`, `phone`
- ETA, nullable: `eta_party_type` (B/P/F), `country`
- Agencies: one party per agent/portal/API channel, created by the migration and whenever a channel is created.
- Direct guests: created from the booking's lead guest at the first invoice or receipt, and editable. Names stay after passport erasure; the spec already keeps names for accounting.

### 3.3 Invoices and credit notes (one table)

**`invoice`**

- `type` (`proforma` | `invoice` | `credit_note`) and `status` (`draft` | `issued` | `partially_paid` | `paid` | `cancelled`)
- `series`, `year`, `seq`, `number` (`INV-2026-00042`; null until issued, never for proformas); unique `(operator_id, number)`
- `billing_party_id`, plus `party_snapshot` and `issuer_snapshot` (jsonb, frozen at issue)
- `credits_invoice_id` (credit notes), `credit_reason`
- `currency`, `base_currency`, `fx_rate` (decimal string), `fx_source`, `fx_date`
- `issue_date`, `due_date`
- `subtotal`, `tax_total`, `total`, `amount_credited`, `amount_paid` (the last two maintained by the engine)
- `notes`, `locale`
- Who and when: `created_by`, `issued_by`, `issued_at`
- ETA, nullable: `eta_uuid`, `eta_submission_status`, `eta_submitted_at`, `eta_long_id`
- `overdue` is derived: `due_date < today and status in (issued, partially_paid)`.

**`invoice_line`**

- `invoice_id`, `seq`, `kind` (`cabin`, `supplement`, `markup`, `commission`, `fee`, `penalty`, `manual`)
- `booking_id` (nullable for manual lines)
- `description_ar`, `description_en`, `quantity`, `unit_amount`, `amount`
- Tax snapshot: `tax_rate_id`, `tax_name_ar`, `tax_name_en`, `tax_bps`, `tax_inclusive`, `tax_amount`
- ETA, nullable: `item_code`, `item_type`, `unit_type`

**`document_counter`**: `(operator_id, series, year)` primary key, `last_seq`.

- **Gap-free numbering:** issuing runs `insert … on conflict do update set last_seq = last_seq + 1 returning last_seq` inside the same transaction that sets the invoice to `issued`. The row lock serialises concurrent issues; a rolled-back issue rolls back the counter, so there is no gap. Postgres sequences are not gap-free, so they are not used.
- **Immutability, enforced by the database and not only the UI:** a trigger rejects any change to a non-draft invoice except `status`, `amount_paid` and `amount_credited`, and any insert, update or delete of lines of a non-draft invoice. Proformas may be edited and deleted; issued invoices never.
- **One open invoice per booking:** a booking line may appear on a new invoice only when its earlier invoice is fully credited (checked in the engine under a booking lock).
- **Rounding** (documented in `decisions.md`): per line, half-up, once.
  - Exclusive tax: `tax = amount × bps / 10000`.
  - Inclusive tax: `tax = amount × bps / (10000 + bps)`.
  - Totals are sums of rounded lines. Lines in another currency than the booking are converted once per line with the invoice's rate.

### 3.4 Receipts, allocations and credit balances

**`receipt`**: money received from (or refunded to) a billing party. Append-only like `payment`.

- `billing_party_id`, `received_on`, `amount` (negative for a refund), `currency`, `method`, `reference`, `received_by`, `note`
- `credit_note_id` (refunds), `reverses_receipt_id`
- Attachment: `attachment` bytea ≤ 5 MB (image or PDF), `attachment_type`, `attachment_name`

**`allocation`**: `receipt_id`, `invoice_id`, `amount` (receipt currency), `invoice_amount` (invoice currency), `fx_rate`, `created_by`. Undone by a negative allocation, never edited.

- **Credit balance** of a party, per currency = receipts − allocations.
- **`vs.payment` gains `receipt_id`** (nullable). The booking ledger stays the source of booking payment status, prepaid confirmation, refunds and the overdue job. One rule keeps the two in step:
  - Recording a payment from a **booking** (today's flow) creates a receipt and its booking payment in one transaction. If the booking is on an issued invoice, an allocation to that invoice is made at the same time.
  - Recording a receipt from a **party** (agency remittance) and allocating it to invoices also writes the matching booking payments: each invoice allocation is spread over that invoice's bookings, oldest balance first. Booking statuses and credit exposure therefore stay right. Manual lines have no booking.
  - **Issuing an invoice** for bookings that already have payments (deposits) allocates those receipts to the new invoice automatically.
- **Refunds** are a negative receipt linked to a credit note. A booking refund also writes the existing `refund` payment, with today's refund cap unchanged.

### 3.5 Indexes

- `invoice (operator_id, billing_party_id, status)`
- `invoice (operator_id, due_date) where status in ('issued','partially_paid')`
- `invoice_line (operator_id, booking_id)`
- `allocation (operator_id, invoice_id)` and `(operator_id, receipt_id)`
- `receipt (operator_id, billing_party_id, received_on)`

### 3.6 Statement, aging and reports

These are queries, not stored tables.

- **Statement** for a party and date range:
  - Opening balance = invoices − credit notes − receipts before the start date.
  - Then dated rows, with a running balance per currency, and a closing balance.
  - Identity tested: closing balance = open invoice balances − unapplied credit.
- **Aging:** open invoice balances by days past `due_date` (current, 1–30, 31–60, 61–90, 90+), by currency, as of a date.
- **Reports:**
  - Invoiced revenue by invoice date × vessel × sailing × channel.
  - Production by sailing date (booked value, invoiced or not).
  - Collections by month × method.
  - Outstanding by party.
  - Filters: date range, vessel, channel, currency. Excel export.

### 3.7 Credit limit

- **Limit:** the limit stays on the channel (one exposure per agency), unless you want it per contract (question 3).
- **Exposure** = uninvoiced confirmed bookings (total + fees − paid) + open invoice balances − unapplied credit, in the limit currency.
- **`block`:** today's behaviour, where the booking becomes a request for staff approval.
- **`warn`:** the booking confirms; the agency booking flow shows the warning and the remaining credit, and the event is audited.

## 4. API (tRPC routers in the back office)

| Router             | Procedures                                                                                                                                                                                                               | Permission                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `financeSettings`  | get, update issuer, logo upload, taxes CRUD, numbering, currencies, account mapping                                                                                                                                      | `finance` (MFA)                                              |
| `parties`          | list, get, update                                                                                                                                                                                                        | read / `finance`                                             |
| `invoices`         | list (filters, overdue), get, createProforma (from bookings and/or manual lines), updateProforma, deleteProforma, issue (proforma → invoice, or direct), creditNote (full/partial), requestPdf (ar/en/both), requestXlsx | read; proformas `bookings.write`; issue and credit `finance` |
| `receipts`         | record (party or booking), allocate, unallocate, reverse, refund, attachment upload/download, list                                                                                                                       | `finance`                                                    |
| `statements`       | get (party, range), requestPdf/Xlsx                                                                                                                                                                                      | read                                                         |
| `receivables`      | aging, outstanding, revenue, production, collections, each with xlsx export                                                                                                                                              | read                                                         |
| `accountantExport` | invoices / credit notes / payments (xlsx, csv), journal (xlsx, csv) with unmapped-code warnings                                                                                                                          | `finance`                                                    |

- The existing `payments.write` permission becomes `finance`. Its holders are the same: owner and finance.
- **Channel API:** no behaviour change. Optional `GET /v1/invoices`, `GET /v1/invoices/{number}` and `GET /v1/statement`, behind a new `finance.read` scope that is off by default. This needs an `api_client.scopes text[]` column (question 13).

## 5. Screens (AR/EN, RTL, mobile)

| Screen                | Contents                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Finance → Invoices    | List with status, overdue badge and filters; New invoice (pick party → bookings to bill → manual lines → preview); invoice detail (lines, taxes, payments, credit notes, PDF ar/en/both, Excel, Share); Issue; Credit note |
| Finance → Payments    | Record payment (mobile layout): party, amount, currency, rate, method, reference, attachment; allocation to open invoices (oldest first, editable); remainder shown as credit                                              |
| Finance → Statements  | Party picker, date range, statement table, PDF/Excel (mobile layout)                                                                                                                                                       |
| Finance → Receivables | Aging table by currency, outstanding by party                                                                                                                                                                              |
| Finance → Reports     | Revenue, production, collections, with filters and Excel export                                                                                                                                                            |
| Settings → Finance    | Issuer details and logo, bank details, currencies, taxes, numbering, ETA footer toggle, account mapping, accountant export                                                                                                 |
| Booking detail        | Invoice status of the booking, Create invoice / proforma                                                                                                                                                                   |
| Agency booking flow   | Remaining credit; warning or block message                                                                                                                                                                                 |
| Today                 | Invoices due within 3 days, overdue invoices, unallocated payments, bookings sailed in the last 7 days without an invoice                                                                                                  |

**Share** on phones uses the browser's share sheet with the PDF file itself, so WhatsApp gets the file and no public link is needed. On desktop it downloads; "Copy link" copies the in-app (sign-in required) address (question 8).

## 6. Migration plan for existing data

One migration, run in a transaction; counts are printed and recorded in the batch report.

1. **Agency parties:** one `billing_party` per `agent`, `portal` and `api` channel, named after the channel.
2. **Guest parties:** one per direct booking that has payments, from its lead guest; other direct bookings get theirs when first invoiced.
3. **Receipts:** each existing `vs.payment` becomes a receipt, set as `payment.receipt_id`. Its party is the booking's billing party.
   - Methods map: `cash` → cash, `bank_transfer` → bank transfer, `card_office` and `gateway` → card, `agent_remittance` → agency credit, `channel` → other (question 10).
   - Refunds and reversals become negative receipts.
4. **Finance settings:** a default row per company, with legal names copied from `operator.name` and no taxes.
5. **No invoices are created for existing bookings** (question 5), so balances start at zero invoiced. The "sailed without an invoice" Today task covers only the last 7 days, so it will not flood.

## 7. How the build would be split (each batch stops for review, like Batches 0–7)

| Batch | Scope                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1    | Finance settings, taxes, billing parties, `finance` permission, invoice/credit-note model, gap-free numbering (concurrency test), immutability trigger, tenant tests |
| F2    | Invoice and credit-note PDF (ar, en, both), Excel, share flow, Invoices screens                                                                                      |
| F3    | Receipts, allocations, credit balance, refunds, attachments, migration of existing payments (counts)                                                                 |
| F4    | Statements, aging, credit limit warn/block, Today tasks                                                                                                              |
| F5    | Reports, accountant export, account mapping, optional API scope                                                                                                      |
| F6    | AR/EN docs pages with real screenshots                                                                                                                               |

Money analytics (cash in, forecast, receivables, revenue by sailing month, currency exposure) is
batch A2 of `analytics-plan.md`, built after F1–F3 on the data they create. F5's read-only reports
stay simple lists and exports; the dashboards live in A2.

## 8. Questions

1. **Who is billed?**
   - `credit` and `channel_collected` contracts → the agency or platform.
   - Back-office (direct) bookings → the guest.
   - What about a `vessel_prepaid` booking made through an agency: the agency or the guest?
2. **Agency invoice amount for commission contracts:**
   - (a) one net amount (the booking's `net_total`), or
   - (b) the gross price with a commission line deducted?
   - (b) lets the journal post commission to its own account. Recommendation: (b).
3. **Credit limit:**
   - Keep it on the channel (today) or move it per contract as the prompt says?
   - Is "block" today's behaviour (the booking becomes a request for approval)?
   - Should new contracts default to `warn`, as the prompt asks? That is a change from today, where every over-limit booking needs approval.
4. **Exposure:** count uninvoiced confirmed bookings plus open invoices minus unapplied credit (as proposed), or open invoices only?
5. **Existing bookings:**
   - Create invoices for bookings already confirmed or sailed, or start invoicing from go-live only (recommended)?
   - Should each company's first number be configurable, for operators continuing a paper series?
6. **Base currency and exchange rates:**
   - Is EGP the base currency for every company?
   - Are rates entered by hand, with the source (e.g. "CBE") and date typed in (recommended), or should Riverdesk fetch them? Fetching is an outside integration.
7. **Taxes:** prices currently include VAT (decision of 2026-10-23), but the prompt's default is no tax lines. Keep the default at none and let each company add an inclusive 14% VAT line itself?
8. **Sharing:** is the phone share sheet with the PDF file, plus an in-app link, enough? Or do you want a public expiring link that a guest can open without signing in? That carries personal data, so it would expire in 7 days.
9. **Cancelled bookings:** invoice only the penalty and fees kept, and credit any earlier invoice in full?
10. **Payment methods:** the prompt lists cash, bank transfer, card, cheque, agency credit and other; the ledger has six existing methods. Is the mapping in § 6 right? Should "channel" (money collected by a platform) stay a method of its own?
11. **Proformas:** they have no legal number. Show «فاتورة مبدئية» with the booking reference (e.g. `PF-RD-26-00012`) as their reference?
12. **Numbers in words:** the prompt makes them optional. Leave them out of the first version?
13. **Channel API:** build the read-only invoice and statement endpoints now (behind the `finance.read` scope, off by default), or leave them out of this phase?
14. **Attachments:** store receipt images and PDFs in Postgres (as documents are today), capped at 5 MB, or set up object storage first?
15. **Batches:** are you happy with the F1–F6 split, stopping for review after each?
