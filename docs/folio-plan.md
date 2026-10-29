# Extras on board and the guest folio — plan

Status: **approved 2026-10-29 with the recommended answers (§ 8); E1 done 2026-10-29.** Answers taken:

1. Connection: online only; a paper chit when the signal drops. No offline queue for now.
2. The on-board login may take payment for folios (cash and card), with the shift report (E2).
3. One folio per cabin.
4. Invoice lines: one per category and day.
5. Split bills: later.
6. Prepaid packages: left out. Tips: free amounts from the price list (a "per night" item the staff post).
7. Agencies: a folio may be billed to the agency where the contract allows it (E2).
8. One folio currency per vessel, USD by default; other currencies at a typed rate when paying.
9. Tax: the company's own tax lines, none by default; no e-receipt link.
10. Batches E1–E3 as listed, each stopping for review.

E1 notes: the price list sits in **Invoices → Settings** (with the taxes it uses), not in Settings.
`folio.write` is owner, finance and on-board; reservations may view folios.

## 1. The idea in one paragraph

Each cabin gets a **folio** (an open bill) when it boards. The on-board staff add **charges** from a
price list: drinks, laundry, spa, optional excursions, tips. They do it on a phone, from the
Check-in screen they already use. Before the guests leave, reception prints the **guest folio**,
the guest pays, and the folio is closed. Payment uses the receipts and invoices built in F1–F6, so
extras appear in the statements, the accountant export and the money analytics with no second
ledger.

## 2. What exists and will be reused

| Area              | What is there                                                                                         | How the folio uses it                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| On-board login    | Role `onboard`, limited to one vessel (`staff_user.vessel_id`); Check-in screen on phone; live marks  | Posts charges and settles folios for its own vessel only                                    |
| Cabins and guests | `booking_cabin` (active/cancelled, `assigned_cabin_id`), guests per cabin, D3 occasions, D4 languages | One folio per booking cabin; a charge may name the guest                                    |
| Invoices          | `invoice` / `invoice_line`, gap-free numbering, immutable once issued, credit notes, taxes snapshot   | Closing a folio issues one invoice with line kind `extra` (new); corrections by credit note |
| Receipts          | `receipt` + `allocation`, guest billing parties, methods cash / bank transfer / card, other currency  | Paying at reception is a receipt from the guest party allocated to the folio's invoice      |
| Agencies          | Billing party per channel; statements; credit exposure                                                | A folio billed to the agency goes on the agency's statement and counts in its exposure      |
| Documents         | Worker → PDF, AR / EN / both, branding                                                                | New kinds `guest_folio` and `folio_shift_report`                                            |
| Analytics         | A2 money tabs, base-currency view                                                                     | Extras revenue per sailing, per guest-night and by category                                 |

## 3. Proposed data model

All tables in schema `vs`, with `operator_id`, RLS, composite foreign keys and a tenant fixture,
like every other table. Money is bigint minor units with a `char(3)` currency.

**`extra_item`** (the price list)

- `category`: `bar`, `minibar`, `restaurant`, `laundry`, `spa`, `excursion`, `gratuity`, `communication`, `shop`, `other`
- `name_ar`, `name_en`, `price`, `currency`, `tax_rate_id` (nullable, from finance settings), `active`, `sort_order`
- `vessel_id` (nullable: null means every vessel)
- Changing a price never changes a charge already posted; the charge keeps its own copy.

**`vessel`** gains `folio_currency` (default `USD`) and `folio_enabled` (default false).

**`folio`** (one per booking cabin and sailing)

- `booking_id`, `booking_cabin_id`, `vessel_id`, `currency`
- `bill_to`: `guest` (the booking's guest party) or `agency` (the channel's party)
- `status`: `open` → `closed` (invoice issued) → `settled` (paid); `void` when nothing was charged
- `opened_at` (at boarding, or the first charge), `closed_at`, `closed_by`, `invoice_id`

**`folio_charge`** (append-only, like `payment`)

- `folio_id`, `guest_id` (nullable), `extra_item_id` (nullable for a manual charge)
- Copies taken when posting: `description_ar`, `description_en`, `category`, `quantity`, `unit_amount`, `amount`, tax name, rate and whether it is inclusive
- `charged_on` (Cairo date), `posted_by`, `posted_at`, `note`
- A mistake is undone by a void line (`voids_charge_id`, `void_reason`), never by editing or deleting
- A trigger rejects new charges on a folio that is not `open`

**Rules**

- A folio cannot close while it has charges in another currency than its own. Payment in another currency uses the typed rate, as receipts do today.
- Closing issues the invoice inside the same transaction: one `extra` line per charge category and day (question 4), with tax per line as in invoicing § 3.3.
- After closing, a correction is a credit note, as for any invoice.
- Cancelling a cabin with an open folio closes the folio first, so charges are never lost.
- No passport numbers, medical notes or dates of birth on any folio screen or document.

## 4. Who may do what

| Permission     | Roles                                 | What it allows                                                        |
| -------------- | ------------------------------------- | --------------------------------------------------------------------- |
| `folio.view`   | owner, reservations, finance, onboard | See folios and their charges (onboard: its vessel only)               |
| `folio.write`  | owner, onboard (+ finance)            | Post and void charges, open and close folios                          |
| `folio.settle` | owner, finance, onboard (question 2)  | Take payment at reception (cash or card) for a folio                  |
| `finance`      | owner, finance                        | Price list, folio currency, bill-to rules; credit notes after closing |

This changes one D2 rule: the on-board login sees **prices of extras** (never cabin prices or
booking payments). Each post, void, close and payment is audited with who did it.

## 5. Screens and documents (AR/EN, RTL, phone first)

| Where                           | What                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Check-in → **Folios** (new tab) | Cabins of the departure aboard; tap a cabin → its folio: running total, add charge (category tiles → item → quantity → guest), void with a reason |
| Check-in → departure leaving    | Folios still open, with totals; Close and take payment; print the folio                                                                           |
| Booking detail                  | The folios of the booking and their status                                                                                                        |
| Settings → Extras               | Price list per vessel, categories, folio currency, enable per vessel, default bill-to                                                             |
| Today                           | Folios left open after disembarkation; folios billed to agencies not yet invoiced                                                                 |
| **Guest folio** PDF             | Branded, AR / EN / both: cabin, guests, every charge by day, voids shown, taxes, total, payments, balance, signature line                         |
| **Shift report** PDF / Excel    | For the purser, per vessel and day: charges by category, payments by method and currency, cash to hand over                                       |
| Analytics → Money               | Extras revenue per sailing and per guest-night, by category and vessel (in the base-currency view as well)                                        |

## 6. Edge cases

- **Guest leaves without paying:** the folio is closed to the agency (if the contract allows) or left as an open guest invoice, which then appears in receivables like any other.
- **Two cabins, one payer:** settle several folios of one booking with one receipt (allocation already supports this).
- **Split bill:** a folio can be closed to two payers by moving charges before closing (question 5).
- **Prepaid packages** (e.g. a drinks package sold with the cabin): out of scope here; they would be a booking supplement priced by the rates engine (question 6).
- **Weak connection on the Nile:** see question 1.

## 7. Proposed batches (each stops for review)

| Batch | Scope                                                                                                                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1    | Price list and settings; `folio` and `folio_charge` with the append-only and closed-folio triggers; permissions; posting and voiding from the Check-in screen; tenant tests |
| E2    | Closing a folio: invoice with `extra` lines, payment at reception through receipts, bill to agency, guest folio PDF, shift report, Today tasks                              |
| E3    | Extras in money analytics and the accountant export; demo price list and folios; AR/EN help pages with real screenshots                                                     |

If the answer to question 1 is the offline queue, it becomes its own batch E4 after E3.

## 8. Questions (recommended answers first)

1. **Connection on board:** start online only, with a paper chit as the fallback when the signal drops (recommended), or build an offline queue on the phone that sends charges when the connection returns (a batch of its own)?
2. **Payment at reception:** may the on-board login take payment for folios (recommended, cash and card only, with the shift report for the hand-over), or only finance staff?
3. **One folio per cabin** (recommended), or one per guest?
4. **Invoice lines:** one line per category and day (recommended, short invoices), or one line per charge?
5. **Split bills:** needed in the first version, or later?
6. **Prepaid packages and tips:** leave packages out for now? Should tips be a suggested amount per guest-night that staff post at the end, or free amounts only?
7. **Agencies:** may a folio be billed to the agency, and should that be allowed per contract (recommended) or for every agency?
8. **Currency:** is one folio currency per vessel enough (recommended, `USD` by default), with payment accepted in other currencies at a typed rate?
9. **Tax:** extras use the company's own tax lines as invoices do (none by default)? Egypt's e-receipt system for sales to consumers is not linked, as for e-invoices.
10. **Batches:** are E1–E3 right, stopping for review after each?
