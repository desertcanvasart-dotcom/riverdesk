# Analytics — plan

Status: **approved 2026-10-26** with the owner's answers in § 8. No code has been written yet. This covers the owner's request of
2026-10-26: analytics for reservation behaviour (A1) and for money (A2), inside the back office,
plus the order in which this and the other open plans are built.

## Roadmap (agreed order, 2026-10-26)

| #   | Batch  | Plan                                     | Status                                   |
| --- | ------ | ---------------------------------------- | ---------------------------------------- |
| 1   | D1     | Branding, bilingual documents            | Done (hosted at 0014)                    |
| 2   | D2     | Check-in documents, on-board login       | Done                                     |
| 3   | **A1** | Reservations analytics (this plan, § 4)  | A1.1 (snapshot) done; A1.2 next          |
| 4   | F1–F3  | Invoices, numbering, receipts            | `invoicing-plan.md`, waiting for answers |
| 5   | F4–F6  | Statements, aging, reports, export, docs | `invoicing-plan.md`                      |
| 6   | **A2** | Money analytics (this plan, § 5)         | Needs invoicing                          |
| 7   | D3–D4  | Remaining cruise stationery              | `documents-plan.md`                      |

The nightly snapshot (§ 3) is the first piece of A1 and ships on its own (A1.1) straight after
D2, because history it does not record cannot be recovered later.

## 1. What exists today

- **Pilot dashboard** (owner only, last 30 days): invariant status, oversells, request answer
  times (median and 90th percentile), bookings by channel. It answers "is the system safe?", not
  "how is the business doing?".
- **Inventory screen**: free, held and booked cabins per departure and category, now.
- **Vacancy sheet**: free cabins per sailing for the coming weeks (PDF, Excel, PNG).
- **Payments screen**: the ledger with totals per currency and kind.
- **No reports area.** The spec's MVP list (occupancy per leg, pickup per week, production by
  channel, cancellations) was never built as screens.

Everything A1 needs is already stored: `inventory_bucket` (total, held, booked per departure and
category), `booking` (channel, market, currency, total, net total, status and its timestamps),
`booking_cabin` (adults, child ages), `guest` (nationality), `quote` (price lines), `audit_log`
(request answers, amendments), `payment` (receipts and refunds).

## 2. Principles

- **In the back office, not an outside BI tool.** Owners will not open a second system; the
  company isolation (row-level security) stays exactly as it is; Arabic and English, right to
  left, Arabic-Indic digits like every other screen; works on a phone.
- **Read-only, from the same database.** Queries run as `vs_backoffice` inside the tenant
  transaction. Heavy figures come from the nightly snapshot, not from scanning every booking on
  each page load.
- **Every figure explains itself.** Each tile has a one-line definition (tap to read it) and opens
  the bookings behind it. Every table exports to Excel.
- **Money is never added across currencies.** Figures are per currency; a base-currency total is
  shown only once invoicing (F1) stores exchange rates, and says which rates it used.
- **Who sees what:** owners and finance see everything; reservations staff see A1 without money
  columns; read-only sees A1. New permission `analytics.view` (owner, finance, reservations,
  read-only) and `analytics.money` (owner, finance).

## 3. The nightly snapshot (first)

Two small tables, written once a day for every future departure and sailing, kept forever (a few
thousand rows per vessel per year).

**`analytics_leg_day`** — capacity by departure and category, as it stood that night.

| Column                                         | Meaning                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `operator_id`, `snapshot_date` (Cairo date)    | Tenant and the night of the snapshot                               |
| `leg_id`, `category_id`, `depart_date`         | The departure and cabin category                                   |
| `capacity`                                     | Cabins on sale (pool + allotments, less blocks)                    |
| `booked`, `held`, `blocked`, `allotted_unsold` | Confirmed, on hold, blocked, in agency allotments but not yet sold |
| `stop_sale`                                    | Whether sales were stopped                                         |

**`analytics_sailing_day`** — what was on the books for each sailing, by channel, market and
currency.

| Column                                                          | Meaning                            |
| --------------------------------------------------------------- | ---------------------------------- |
| `operator_id`, `snapshot_date`                                  | Tenant and night                   |
| `sailing_id`, `embark_date`, `channel_id`, `market`, `currency` | The grouping                       |
| `bookings`, `cabins`, `guests`, `cabin_nights`                  | Confirmed volume                   |
| `value_total`, `value_net` (bigint minor units)                 | Guest price and net to the company |
| `requests_open`, `holds_open`                                   | Pipeline not yet confirmed         |

- **When:** a worker job at 23:30 Cairo time (computed in Postgres, so daylight saving does not
  matter). Re-running the same night overwrites that night's rows, so a missed or repeated run is
  harmless.
- **Isolation:** both tables carry `operator_id`, row-level security and a tenant fixture, like
  every other table.
- **Backfill once:** past nights are rebuilt from booking and cancellation timestamps and marked
  `reconstructed = true`. Holds, amendments and moved cabins cannot be rebuilt exactly; screens
  show a small "estimated" mark on those nights.

## 4. A1 — Reservations analytics

A new **Analytics** item in the sidebar, with four tabs. Filters on every tab: vessel, date range
(embarkation date or booking date), channel, market, cabin category.

**4.1 Overview** (the owner's one-page answer to "how are we doing?")

- Occupancy of the next 30 / 60 / 90 days of departures, and of the last 30 days.
- Cabins and value booked this week and this month, against the same period last season.
- Pace: cabins on the books for the next 90 days today, against 7 and 28 nights ago.
- Requests: answered within the agreed time, and how many became bookings.
- Cancellation rate this month.

**4.2 Occupancy and pace**

- Per sailing: capacity, booked, held, free, occupancy %, and a pace line (cabins on the books
  night by night as the sailing approached), against the same calendar date a year earlier (the
  sailings departing that date, if any).
- Per cabin category: which categories sell first and which stay empty.
- A heat map of the coming weeks (sailings × categories), coloured by occupancy.

**4.3 Channels and markets**

- Per channel: bookings, cabins, cabin-nights, value, average price per cabin-night, share of the
  total, cancellation rate, request answer time and request-to-booking conversion.
- Per market and guest nationality: the same volume figures, plus average group size and the
  share of bookings with children.
- Allotments: cabins given to each agency, sold, released back, and released unsold.

**4.4 Booking behaviour**

- Booking window: how many days before embarkation people book, as a distribution, by channel and
  market.
- Length of cruise chosen (nights), and the most-sold itineraries.
- Holds: how many became bookings and how many expired; average hold time.
- Cancellations: when they happen (days before embarkation), by channel and market, and the
  penalties kept.
- Amendments: how many, what changed (dates, cabins, guests), and the fees charged.

**Definitions** (also shown on screen)

- **Occupancy** = cabin-nights booked ÷ cabin-nights on sale, over the departures in range.
- **Average price per cabin-night** = guest value ÷ cabin-nights, per currency.
- **Revenue per available cabin-night** = guest value ÷ cabin-nights on sale (the cruise version
  of a hotel's RevPAR), per currency.
- **Pace** = cabins confirmed for a sailing as of a given night, from the snapshot.
- **Booking window** = embarkation date − confirmation date, in days.

## 5. A2 — Money analytics (after invoicing)

Built on the invoices, receipts and allocations of F1–F3, and the exchange rates they store.

- **Cash in:** collected per day, week and month, by method and currency; against what was due.
- **Cash forecast:** deposits and balances falling due in the next 4, 8 and 12 weeks, from the
  payment schedules, with what agencies owe on credit.
- **Receivables:** aging by agency (current, 1–30, 31–60, 61–90, 90+), average days to pay per
  agency, credit used against each limit.
- **Revenue:** by sailing month (when it sails) and by booking month (when it was sold), by vessel,
  channel and market; invoiced against not yet invoiced.
- **Money held for future sailings:** deposits and payments received for sailings not yet sailed.
- **Currency exposure:** amounts on the books and still due, per currency.
- **Leakage:** commissions paid, refunds, penalties kept, amendment fees, discounts.
- A **base-currency** view (EGP by default) using the stored rates, always labelled with them.

## 6. Screens, API, tests

- **Screens:** `/analytics` with the tabs above; tiles, tables and simple charts (bars and lines
  drawn as SVG, no new chart library); every table exports to Excel through the existing document
  worker; mobile layout for the Overview.
- **API:** a tRPC `analytics` router, one read procedure per tab, inputs validated with zod; no
  Channel API endpoints in this phase.
- **Engine:** one module per tab in `packages/engine/src/analytics/`, SQL in the tenant
  transaction, typed results.
- **Tests:** a fixture company with known bookings, holds, cancellations and allotments, checking
  every definition in § 4 exactly; snapshot idempotency (two runs, same rows); tenant isolation of
  the new tables (automatic); a performance check on a seeded year of data.

## 7. Batches

| Batch | Scope                                                                               |
| ----- | ----------------------------------------------------------------------------------- |
| A1.1  | Snapshot tables, nightly job, backfill, tests                                       |
| A1.2  | Overview and Occupancy and pace                                                     |
| A1.3  | Channels and markets, Booking behaviour, Excel exports, AR/EN docs with screenshots |
| A2    | Money analytics, after invoicing F1–F3 (split when we get there)                    |

Each stops for review, like the other batches. A1.1 is small and could ship on its own straight
after D2, so the snapshot starts recording as early as possible.

## 8. Answers (owner, 2026-10-26)

1. **Pace comparison:** against the **same calendar date a year earlier** (the sailings departing
   that date, if any), not the same itinerary and weekday.
2. **Seasons:** "this season / last season" use the seasons already defined in Rates.
3. **Reservations staff** see A1 without money columns (`analytics.view`); money needs
   `analytics.money` (owners and finance).
4. **Nationality** is reliable enough to report on now.
5. **A1.1** (the snapshot) ships on its own straight after D2.
