# Decisions

One entry per decision: date, decision, reason. The spec (`docs/spec-v2.md`) is the source of truth; these fill its gaps.

## Part 0 (data model)

**2026-10-23 · Legs split at every boarding stop.**
A schedule template is an ordered list of stops (port, day offset, times, `embark_allowed`, `disembark_allowed`). A leg runs between two consecutive stops where guests may board or leave. Ports include Cairo, Luxor, Esna, Aswan, Abu Simbel and others added by staff.
Reason: the operator confirmed guests embark and disembark at Cairo, Luxor, Esna, Aswan, Abu Simbel and other places. Splitting legs later, once bookings exist, would be very costly. Because every booking covers consecutive legs, a cabin assignment still always exists while each leg's count fits.

**2026-10-23 · Sailing patterns are defined by embark stop and disembark stop.**
A `sailing_pattern` names the embark stop and the disembark stop (which may be in a later template cycle). Its sailings take every leg in between.
Reason: this follows from leg splitting. Any route, including Lake Nasser and Cairo itineraries, is just a different leg set.

**2026-10-23 · Rates are flexible by unit and period.**

- `rate.unit` is `per_person` or `per_cabin`.
- `rate.period` is `per_night` or `per_package`.
- Package rates are keyed by sailing pattern; per-night rates are multiplied by the sailing's nights.
- Per-person rates keep the single, double and triple basis. Per-cabin rates are keyed by category and cover occupancy up to the category maximum.
- The season is taken from the embark date.

Reason: the operator said vessels differ (per person or per cabin type, per night or per 3- or 7-night package), and the system serves many channels and operators.

**2026-10-23 · Child policy uses configurable bands.**

- Each band has an age range and a basis: `free`, `percent_of_adult`, `fixed` or `included` (inside a per-cabin price), plus optional sharing conditions.
- Pilot default: under 2 free; 2–5 at 25%; 6–11 at 50%; 12+ adult. The percentage is of the adult double rate, and applies when sharing with two adults.
- A child sharing with one adult pays the adult double rate.
- Age is taken on the embark date. Every child counts toward occupancy.

Reason: confirmed by the operator. "Below 2 free, 3–6 25%" was read as 2–5 at 25%, so that ages 2 and 6 each fall in exactly one band.

**2026-10-23 · A date-of-birth mismatch is flagged, never repriced.**
If a guest's date of birth puts them in a different band than the one quoted, an item goes on the action list and the price stays as quoted.
Reason: confirmed by the operator.

**2026-10-23 · Three payment modes per channel contract.**
`channel_contract.payment_mode` is one of:

- `channel_collected`: the channel collects from the guest and settles with the operator. Confirm is immediate; the ledger records the amount due from the channel.
- `vessel_prepaid`: a payment hold until the deposit is received.
- `credit`: confirmed without payment, within the credit limit.

nilecrz uses `channel_collected`.
Reason: the operator confirmed nilecrz collects guest money and settles with the operator. Other channels may work differently.

**2026-10-23 · Prices include VAT.**
There are no separate tax lines in the MVP. Price lines carry a `kind`, so tax lines can be added later without a migration.
Reason: confirmed by the operator.

**2026-10-23 · Amendment fees are optional rules.**
Each cancellation policy holds zero or more amendment fee rules: kind of change, flat or percent, days-before window. The default is none.
Reason: the operator is unsure and asked to keep it flexible.

**2026-10-23 · One currency per rate plan.**
A rate plan has one currency (USD, EUR or EGP). Egyptian and resident guests usually book EGP plans. A quote is always in its rate plan's currency, with no conversion at quote time. A payment in another currency records `fx_rate` and the booking-currency equivalent.
Reason: international rates are in USD and EUR, and Egyptians sometimes pay in EGP.

**2026-10-23 · Each agency is its own channel.**
Each agency is a channel of type `agent` with its own contract. Walk-in, phone and WhatsApp guests use the operator's single back-office channel.
Reason: confirmed by the operator.

**2026-10-23 · Emergency blocks use an `overcommit` counter.**
Pool buckets have an `overcommit` counter. Invariant 3 becomes held + booked ≤ total + overcommit. The check also requires that overcommit > 0 only while `stop_sale` is set and an `oversubscription` exception is open.
Reason: confirmed by the operator. This lets an emergency block exceed free without breaking the invariants gate.

## Part 0 (structure)

**2026-10-23 · Pilot cruises.**
4 and 7 nights from Luxor; 3 and 7 nights from Aswan. More patterns are added as data.
Reason: "3 nights from Luxor" can't be built from the pilot's legs.

**2026-10-23 · Charters are not in the MVP.**
`booking.kind` exists, with only `cabins` allowed. `charter_rate` goes to the backlog.
Reason: the default for open decisions.

**2026-10-23 · The outbox `event` table is created in Batch 1.**
Webhook delivery stays in Batch 5.
Reason: rule 3 requires an outbox event on every transition from Batch 1 on.

**2026-10-23 · When the booking row is created.**
Checkout and option holds create the booking at confirm (`hold.booking_id` is nullable). Request flows create the booking first.
Reason: this keeps abandoned checkouts from creating bookings.

**2026-10-23 · Allotment release flag on the bucket.**
The flag is `released_at` on the allotment `inventory_bucket` row.
Reason: the cancel-vs-release race (test 4) needs both sides to lock the same row.

**2026-10-23 · Date-effective cabins.**
A `cabin_period` table stores category and active status per date range. Invariant 1 counts cabins as of each leg's dates.
Reason: a cabin can be recategorised or removed from a given date.

**2026-10-23 · Schedule exceptions on legs with bookings.**

- A shift or port change applies to the leg, and its bookings move with it.
- A cancellation or dry-dock sets the leg to `cancelled` and stops sales.
- In both cases an exception is raised and `sailing.changed` is emitted. Bookings are never moved or cancelled automatically.

Reason: the spec flags affected bookings rather than refusing the change.

**2026-10-23 · Cross-tenant safety.**

- Every reference within a tenant uses a composite foreign key `(operator_id, id)`.
- Lookups that must run before the tenant is known (staff login, API client, the worker's operator list) are `SECURITY DEFINER` functions that return ids only. They are checked against an allow-list in the harness.

Reason: foreign-key checks ignore RLS, and those lookups can't set `app.operator_id` before they run.

**2026-10-23 · Back-office `requestKey` reuses `idempotency_key`.**
The key is scoped to the back-office channel.
Reason: one mechanism for duplicate protection.

**2026-10-23 · Generated documents are stored in Postgres.**
A `document` table holds the file as `bytea`.
Reason: Supabase Storage would need the `service_role` key in the worker, which rule 7 forbids.

**2026-10-23 · Cairo-time jobs run frequently.**
Jobs tied to Cairo time run every 15 minutes and select due work with `now() AT TIME ZONE 'Africa/Cairo'`.
Reason: Egypt observes DST again (since 2023), so a fixed cron time would drift.

**2026-10-23 · Time-travel in tests uses the owner connection.**
Test fixtures may use the owner connection only to move `expires_at` and similar times. All actions and assertions run as the runtime roles.
Reason: tests 3 and 8 need holds that expire "now".

## Stack

**2026-10-23 · Stack as proposed in the prompt, with these changes:**

- Migrations use a small in-repo SQL runner (tracking table, checksums, one transaction per file) run as `vs_owner`. The Supabase CLI only provides the local stack.
- Data access uses `pg` with Kysely and `kysely-codegen`. On hosted Supabase, runtime roles connect through the Supavisor transaction pooler with prepared statements off.
- An ESLint `no-restricted-imports` rule stops `apps/*` from importing database write access, so only `packages/engine` writes (rule 1).
- CI runs `supabase start` with unused services excluded.

Reason: the prompt asks for plain SQL migrations and a single write path, and all apps share the same database roles, so Postgres alone can't enforce rule 1.

## Batch 0

**2026-10-23 · Tool versions.**
Node 22 (≥ 22.18, required by Graphile Worker), pnpm 10, TypeScript 6.0, Next.js 16, Vitest 5, ESLint 10, Kysely 0.29, Graphile Worker 0.18, Fastify 5, zod 4, pino 10.
Reason: current stable releases. TypeScript stays on 6.0 because typescript-eslint does not support TypeScript 7 yet.

**2026-10-23 · All tables live in schema `vs`, not `public`.**
Supabase exposes `public` through its Data API (PostgREST) to the `anon` and `authenticated` roles. Schema `vs` gives them no access at all, and a test checks this. Kysely queries are qualified with `WithSchemaPlugin('vs')`.
Reason: defence in depth for tenant data, on top of RLS.

**2026-10-23 · `vs_owner` cannot log in.**
Migrations connect as the admin user (`postgres`) and run each file under `SET LOCAL ROLE vs_owner`, so every object is owned by `vs_owner`. Role passwords are sent as SCRAM verifiers, never in clear text.
Reason: rule 7 says the owner is never used at runtime; a role that cannot log in can't be.

**2026-10-23 · `staff_user.auth_user_id` has no foreign key to `auth.users`.**
It is unique instead, so one login maps to one operator.
Reason: hosted Supabase lets `postgres` grant only SELECT on `auth.users`, not REFERENCES, so a role we create cannot hold the foreign key.

**2026-10-23 · Append-only tables have `created_at` only.**
`audit_log` has no `updated_at`, and runtime roles have no UPDATE or DELETE on it. `exception` rows are resolved, never deleted (no DELETE). Runtime roles cannot create or delete operators or their settings rows; that is a platform task.
Reason: rule 11 and the spec's audit requirements.

**2026-10-23 · Tenant setting read with `nullif(..., '')`.**
`vs.current_operator_id()` returns NULL when `app.operator_id` is missing or empty, so policies match nothing.
Reason: after a `SET LOCAL` transaction ends, Postgres leaves the setting as `''` on that connection, and `''::uuid` would raise an error instead of returning no rows.

**2026-10-23 · Graphile Worker's tables get an explicit `vs_worker` policy.**
Graphile Worker turns on RLS (with no policies) for its private tables. The migration runner adds one policy per table allowing only `vs_worker`. The back office and API have no access to the `graphile_worker` schema.
Reason: the worker must not run as the owner (rule 7), and those tables hold job metadata, not tenant data.

**2026-10-23 · Graphile Worker connects in session mode.**
The worker uses the session-mode port (`DATABASE_SESSION_PORT`, 5432 on the Supabase pooler) because Graphile Worker uses LISTEN/NOTIFY. The back office and API use the transaction-mode port.
Reason: LISTEN/NOTIFY does not work through a transaction-mode pooler.

**2026-10-23 · The cron schedule is in UTC.**
Graphile Worker evaluates crontab entries in UTC. `nightly_invariants` runs at 00:00 UTC, which is 02:00 or 03:00 in Cairo.
Reason: jobs tied to a Cairo date compute that date in Postgres (see "Cairo-time jobs run frequently").

**2026-10-23 · The cross-tenant harness requires a fixture per table.**
The harness discovers tenant tables from the catalogue. A tenant table without a fixture in `TENANT_FIXTURES` fails the harness, and so does a table in `vs` with no tenant column that is missing from `NON_TENANT_TABLES` (currently empty).
Reason: new tables are covered automatically, and a forgotten fixture can't silently skip one.

**2026-10-23 · Relative imports have no file extension.**
Imports are written like `./money`, not `./money.js` (`moduleResolution: Bundler`). Workspace packages export TypeScript source directly, and the apps run it through tsx or Next.js. There is no separate build step for packages.
Reason: Turbopack (Next.js 16) does not map `.js` specifiers onto `.ts` files in workspace packages. One import style works for tsx, Vitest, tsc and Next.js.

**2026-10-23 · Integration tests run one package at a time.**
`pnpm test` runs packages sequentially, and the files within each package run sequentially too.
Reason: the harness and its negative control change the catalogue (a probe table), and the concurrency tests in later batches need predictable connection counts.

**2026-10-23 · Local Supabase uses ports 55320–55329.**
Reason: another local Supabase project (nilecrz) already uses the default 543xx ports on the development machine.

**2026-10-23 · Hosted settings live in `.env.hosted`, not `.env.local`.**
Reason: Next.js loads `.env.local` automatically in development, which would point local runs at the hosted database. Tests, `seed` and `reset` refuse any database that isn't local.

## Batch 1

**2026-10-23 · A cabin counts on a leg if it is in service on the leg's departure date.**
`cabin_period` stores a cabin's category and when it is in service, as date ranges that may not overlap. Invariant 1, generation and `changeCapacity` all use the same rule.
Reason: one rule everywhere. A cabin removed partway through a leg still serves that leg, which matches what happens on board.

**2026-10-23 · `changeCapacity` replaces the cabin's state from the effective date onward.**
Periods that start after that date are dropped, and the new state applies from the date on. The date may not be in the past (Cairo date, from the database clock). Adding a cabin to a category that has no pool bucket on an existing leg creates that bucket first.
Reason: the simplest rule that keeps invariant 1 exact. Scheduled changes are made one at a time.

**2026-10-23 · Counters cannot go negative.**
`total`, `held`, `booked` and `overcommit` have `CHECK (>= 0)` constraints. `held + booked <= total + overcommit` is not a constraint; `check_invariants()` checks it and the conditional updates enforce it.
Reason: negative counts are never valid. The upper bound is checked by the function so an emergency block can go over free (see the overcommit decision in Part 0).

**2026-10-23 · Stop-sale reasons.**
`stop_reason` is one of `manual`, `emergency_block` or `invariant`. Releasing the block that caused an overcommit lifts an `emergency_block` stop once the overcommit is back to zero, and resolves the oversubscription exception. Resuming sales is refused while a bucket is still overcommitted.
Reason: invariant 3 requires an overcommitted bucket to stay stopped with an open exception.

**2026-10-23 · An outbox event's `resource_version` is the owning row's `version`.**
Buckets, legs and sailings carry a `version` that every change increments. `availability.changed` is emitted per pool bucket. Its payload holds the vessel, leg and category ids and the cause, never personal data.
Reason: monotonic per resource without a separate counter table, and no extra lock.

**2026-10-23 · How `generateSchedule` works.**

- It locks the vessel row, so it never interleaves with `changeCapacity` or schedule exceptions, which read the same cabins and legs.
- It plans cycles from the template's `valid_from`, keeps legs departing between today (Cairo) and the horizon (18 months), and skips dry-dock ranges.
- A planned leg that overlaps a live leg is skipped and returned as a conflict instead of failing the whole run.
- It creates a sailing only when every leg in its chain exists and is open. "7 nights from Aswan" in the last generated week appears on the next run that adds the following week.

Reason: idempotent; never changes or deletes an existing leg.

**2026-10-23 · How schedule exceptions are applied.**

- `cancel` and `dry_dock` set the legs and their sailings to `cancelled`. Counters stay as they are, so bookings remain until staff move them.
- `shift` moves legs by whole days. The no-overlap constraint is deferrable, so a run of legs can move together, but overlaps are still refused (`SCHEDULE_CONFLICT`).
- After any change, a sailing whose legs no longer join up (one leg must end on the date and at the port where the next begins) is set to `closed`.
- Legs with commitments raise one `schedule_change` exception. Every touched sailing emits `sailing.changed`.

Reason: the spec flags affected bookings rather than refusing the change; a sailing with a gap night or a port jump must not stay on sale.

**2026-10-23 · The demo vessel is defined in `@vs/engine` and seeded through the engine.**
`pnpm db:seed` creates the operator and staff (`@vs/db`), then the vessel, cabins, template, patterns and 18 months of schedule through engine functions running as `vs_backoffice`.
Reason: the seed exercises the same write path as staff do (rule 1), and `@vs/db` does not depend on its own consumer.

**2026-10-23 · Commitments are simulated in tests until Batch 3.**
Tests set `held` and `booked` on pool buckets directly as the owner (`simulateCommitment`), always within invariant 3. Batch 3 replaces these with real holds and bookings when invariant 2 arrives.
Reason: the prompt asks for a test-only fixture until holds and bookings exist.

## Batch 2

**2026-10-23 · Rounding.**
Amounts are integer minor units throughout. Each price line is rounded once, half-up: a child's percentage of the adult double rate, and each per-cabin markup or commission line. Totals are sums of the rounded lines. Per-night prices are whole-number multiplications, so they never need rounding.
Reason: the prompt's rule. One rounding per line makes every total reproducible by hand.

**2026-10-23 · How unit, period and basis combine.**

- A rate plan sets `pricing_unit` (`per_person` or `per_cabin`) and `pricing_period` (`per_night` or `per_package`).
- Per-person rates have a basis: the price per person when 1, 2 or 3+ people pay the adult rate. Those "payers" are the adults, children at or above the adult age, and children whose band needs two adults when the cabin has only one (they pay the adult double rate).
- Package rates are keyed by sailing pattern. Per-night rates are multiplied by the sailing's nights.

Reason: the operator's answer that vessels price per person or per cabin, per night or per package.

**2026-10-23 · Children in per-cabin plans.**
A per-cabin price covers everyone in the cabin. Only `fixed` child bands add to it; free, included and percentage bands appear as zero lines.
Reason: a percentage of an adult rate has no meaning when there is no per-person rate; this follows the Part 0 decision that per-cabin prices cover occupancy up to the category maximum.

**2026-10-23 · Occupancy rules.**
Every cabin needs at least one adult. The adults may not exceed the category's `max_adults`, all guests may not exceed `max_occupancy`, and children may not exceed the policy's `max_children_per_cabin` (default 2). Every child counts toward occupancy.
Reason: this reproduces the default "max 1 child per double, 2 per triple" from the categories' maximum occupancy.

**2026-10-23 · Ages are taken on the embark date.**
A quote accepts child ages or dates of birth; dates of birth are converted to the age on the embark date. Ages 0–1 free; 2–5 at 25%; 6–11 at 50%. Both percentage bands need two adults; 12 and over pay the adult rate.
Reason: the operator's child policy. "Below 2 free, 3–6 25%" was read as 2–5, so that ages 2 and 6 each fall in exactly one band.

**2026-10-23 · Supplements.**
A supplement belongs to a rate plan, which fixes its currency. It is charged once for each night of the sailing within its date range; nights run from the embark date to the night before disembarking. Adult-rate guests pay the adult amount; children who are not in a free band pay the child amount. Only mandatory supplements are priced; optional ones are in the backlog.
Reason: a gala dinner on the disembark date is not part of the cruise.

**2026-10-23 · Markup and commission.**

- Markup: the rates are net, and one markup line per cabin adds to the price.
- Commission: the rates are the selling price, and one commission line per cabin records what the channel keeps. It is not part of the total; `net_total` = total − commission.
- nilecrz: no adjustment.

Reason: "net or commissionable as contracted" (spec § Agent portal).

**2026-10-23 · How a rate plan is chosen.**
The rate plan must be in the channel's contract and match the requested market. If the contract has several plans for a market, the caller names one. Each plan has one currency.
Reason: the Part 0 currency decision. A quote is always in its plan's currency.

**2026-10-23 · Quote shape.**
A quote stores its lines, the resolved cabins and the policy snapshots (cancellation rules, amendment fees, payment terms, child policy, inclusions and exclusions, contract terms) as JSON. It is immutable: runtime roles cannot update or delete it. It expires after the longer of the contract's checkout and option holds.
Reason: the spec's quote contents; immutability guarantees that later rate changes never touch a quote. This replaces the `quote_cabin` and `quote_line` tables proposed in Part 0.

**2026-10-23 · nilecrz's payment mode is `channel_collected`.**
The prompt's Batch 2 seed says "prepaid".
Reason: the operator confirmed in Part 0 that nilecrz collects the guest's money and settles with the operator.

**2026-10-23 · `charter_rate` is not built.**
Reason: charters are not in the MVP (see backlog).

**2026-10-23 · Runtime role passwords are set only when login fails.**
The bootstrap no longer re-sets an unchanged password on every migration run.
Reason: re-setting a password, even unchanged, makes the Supabase pooler drop its cached credentials, so the apps' logins would fail for a few seconds after every deploy.

## Batch 3

**2026-10-23 · Booking references are `PREFIX-YY-NNNNN`.**
The prefix is per operator (`operator_setting.booking_ref_prefix`, default `VS`). The year is taken from the Cairo date. The number comes from one global Postgres sequence, so numbers have gaps and are not consecutive per operator.
Reason: the operator chose this format. A sequence never blocks, while a counter row would make every confirmation queue behind the others.

**2026-10-23 · Cancellation penalties are a percentage of the full booking total, supplements included.**
The percentage comes from the booking's latest revision snapshot. Days before embarkation are counted on the Cairo date from the database clock. On or after the embark date, the 0-day rule applies.
Reason: the operator chose this.

**2026-10-23 · Bucket choice per leg × category.**
All n cabins come from one bucket: the channel's active, unreleased allotment if it has n free, otherwise the pool, unless the contract is allotment-only. A stopped pool bucket refuses every channel on that leg × category, including allotments.
Reason: the spec's rule. Taking all cabins from one bucket means each booking line has one clear source to return to.

**2026-10-23 · Prepaid (`vessel_prepaid`) bookings wait in `held`.**
Confirming a checkout or option hold for a prepaid contract turns that hold into the booking's payment hold, with the TTL from the payment policy snapshot (default 24 hours). The booking status is `held`. `confirmPaymentHold` moves the cabins from held to booked; Batch 4 calls it when a payment is recorded.
Reason: spec § Payments: a payment confirms a booking only while it still holds its cabins.

**2026-10-23 · Requests are allowed on every contract; holds are refused on on-request contracts.**
Reason: staff and agents may ask for an instant sailing, but an on-request channel must never take cabins directly.

**2026-10-23 · Lock order beyond rule 5.**

- Hold row first, then the offer, then the booking, then buckets, for every hold-based transition, including expiry and accepting an offer.
- Cancelling an unpaid prepaid booking releases its payment hold before updating the booking.
- The expiry job takes hold rows with `FOR UPDATE SKIP LOCKED`, so it never waits on a confirmation.

Reason: the same order everywhere means no lock cycles.

**2026-10-23 · Request keys run in the same transaction as the write.**
The key row in `idempotency_key` (scoped to the channel) is inserted in the same transaction. A concurrent duplicate waits on the unique index and then returns the committed result; bigint and Date values survive the round trip. The same key with a different body is refused with `IDEMPOTENCY_KEY_REUSED`.
Reason: back-office double-click protection. API idempotency, where the key is committed as `in_progress` before the work starts, comes in Batch 5.

**2026-10-23 · How amendments are applied.**
The engine compares required cabins per leg × category with the current confirmed lines. It acquires every increase first, then releases every decrease. Kept lines keep their bucket and move to the new cabin rows. Cabins are updated in place by index, new ones are added, and the rest are cancelled; guests of a cancelled cabin move to cabin 0. The fee is the highest matching amendment-fee rule, plus the cancellation penalty on any reduction in the total within a penalty window.
Reason: spec § Amendments ("removed nights inside the penalty window are charged as a cancellation").

**2026-10-23 · Guest age mismatches are compared by price band.**
Each child guest with a date of birth must match a quoted child in the same price band from the booking's child policy. Otherwise a `guest_age_mismatch` exception is opened (once per booking). Nothing is repriced.
Reason: the Part 0 decision. Comparing bands, not exact ages, avoids flagging a child who simply had a birthday after the quote.

**2026-10-23 · Passport encryption details.**
AES-256-GCM, with a fresh IV per value and the key id as additional authenticated data; the key id is stored with the ciphertext. Old keys stay readable through `PASSPORT_PREVIOUS_KEYS`. Guest audits record counts only, never names or passport numbers.
Reason: rule 9.

**2026-10-23 · When the booking jobs run.**
`expire_holds` runs every minute, `expire_requests` every 5 minutes, `release_allotments` every 15 minutes and `complete_bookings` hourly. A release is due when `depart_date − release_days ≤ today (Cairo)`, compared in Postgres, which also covers the prompt's daily 00:05 run and its hourly catch-up.
Reason: the Batch 0 decision on Cairo-time jobs; Egypt's DST would make a fixed cron time drift.

## Between Batches 3 and 4

**2026-10-23 · A temporary read-only progress page at `/progress`.**
The back office shows the demo operator's counters, invariant status, a 6-week availability grid, bookings, holds, quotes and open exceptions. It reads through one engine function (`getOverview`), so rule 1 still holds, and returns 404 when `VS_ENV=hosted`. `pnpm db:seed` now also adds sample activity through the engine.
Reason: the operator asked to look around before the real screens exist. It is deleted in Batch 6.

## Batch 4

**2026-10-23 · The payment ledger is append-only.**
Receipts are positive. Refunds and reversals are negative. A payment can be reversed once, and a reversal cannot itself be reversed. Runtime roles have no UPDATE or DELETE on `payment`. `booking.amount_paid` is the running sum in the booking currency.
Reason: spec § Recording payments ("can only be reversed by a new entry").

**2026-10-23 · Payments in another currency.**
The exchange rate is a decimal string with up to 6 decimal places (1 unit of the payment currency = rate units of the booking currency). The booking-currency equivalent is stored next to the original amount, rounded half-up once. A payment in another currency without a rate is refused.
Reason: the operator agreed to this recommendation; no floats (rule 10).

**2026-10-23 · How deposit, balance and payment status are set.**

- The deposit is the deposit percentage × total, rounded half-up. The balance is due on embarkation minus `balance_due_days`. Both come from the booking's policy snapshot, and both are recomputed whenever the total or the sailing changes (offer accepted, amendment).
- Payment status runs `unpaid` → `deposit_paid` → `paid` against total + fees.
- After a cancellation, or for a paid-but-unavailable booking, the status is `refund_due` while more was received than is kept, then `refunded`.

Reason: these are the five statuses the prompt lists.

**2026-10-23 · A prepaid booking confirms when the total received reaches the deposit.**
A smaller payment is recorded and the booking stays `held`.
Reason: spec § Payments ("when the deposit (or full amount) is received while the payment hold is active").

**2026-10-23 · A late payment retakes the cabins inside a savepoint.**
When a payment arrives after the payment hold expired (whether or not the expiry job has run), the engine first finishes the expiry, which releases the hold's cabins. It then takes the cabins again in a savepoint. If any leg is full, the savepoint is rolled back and the booking becomes `paid_unavailable`, with a critical exception and a `booking.paid_unavailable` event. The money is still recorded and is fully refundable.
Reason: spec test 8. A booking is never confirmed without its cabins, and received money is never lost.

**2026-10-23 · How the credit limit works.**
Credit is off until set per agent. Exposure is the sum of total + fees − paid over the agent's confirmed bookings in the limit's currency; a booking in another currency counts as over the limit. The agent's channel row is locked during the check, so two concurrent confirmations cannot both pass. Over the limit, the booking becomes a request and the hold is released at once. Staff accepting the request approve the credit.
Reason: the operator agreed to this recommendation.

**2026-10-23 · What a refund may return.**
After a cancellation, the refundable amount is what was received minus the penalty and amendment fees. For a paid-but-unavailable booking, everything is refundable. A refund larger than the refundable amount is refused.
Reason: penalties and fees come from the booking's policy snapshot.

**2026-10-23 · Amendment fees add to what is owed.**
They accumulate in `booking.fees`. They are owed on top of the cruise total and kept on cancellation.
Reason: the Batch 3 fee rule; the ledger example shows it.

**2026-10-23 · Overdue balances (daily job at 05:00 UTC).**
Overdue balances of prepaid bookings open one `late_payment` exception and one `payment.overdue` event; that event is the notice to the channel. Automatic cancellation happens only when the booking's payment policy snapshot enables it, `auto_cancel_after_days` after the due date. It is off by default.
Reason: spec § Prepaid rules.

**2026-10-23 · The action list is a query.**
`getActionList` returns holds expiring today, open requests with SLA hours left, deposits due, balances overdue or due within 3 days, paid-but-unavailable bookings and open exceptions. Missing guest details and unassigned cabins join it in Batch 6, alongside cabin assignment.
Reason: the Batch 6 home screen reads it as is.

## Multi-tenancy (agreed 2026-10-24)

**2026-10-24 · The platform owner adds companies.**
A platform-admin command (built in Batch 5; a small admin screen later) creates the company (operator) with its settings, its back-office channel and an invite for its first owner. There is no self-service sign-up.
Reason: the platform owner controls who joins. Sign-up, approval and billing are not needed for the pilot.

**2026-10-24 · One login per company.**
A staff login belongs to exactly one company (`staff_user.auth_user_id` is unique). Someone working for two companies uses two logins.
Reason: simplest and safest for isolation, and no change to the data model.

**2026-10-24 · nilecrz gets API credentials per company.**
nilecrz is a channel of each company that sells through it, and holds one API client per company. Each company controls its own contract with nilecrz and can switch it off. There is no cross-company account.
Reason: fits the existing isolation; every API call stays inside one tenant.

**2026-10-24 · The platform is owned by nilecrz's company.**
The company that runs nilecrz also owns and runs the vessel system; cruise companies are its customers. This answers the spec's open "ownership" question. Consequences:

- nilecrz gets no privileged access. It is a channel under a contract like any other portal, sees only what each company's contract allows, and never sees other channels' allotments, holds or bookings.
- Platform-level access (break-glass, migrations) stays separate from the nilecrz application and its credentials.
- The terms offered to cruise companies should state this neutrality.

Reason: the operator's answer.

## Batch 5 (part 1: contract and onboarding)

**2026-10-24 · The API contract is `packages/contracts/openapi.yaml` (OpenAPI 3.1).**

- Request and response types are generated from it (`pnpm --filter @vs/contracts generate:api`), and CI fails if the generated file is stale.
- Tests check that it is valid OpenAPI 3.1, that its error codes equal the error catalogue, that every write requires `Idempotency-Key`, and that no response schema has a passport or birth-date field.
- The API serves it at `/openapi.yaml`, with interactive docs (Scalar) at `/docs`.

Reason: the prompt puts the contract first.

**2026-10-24 · API conventions.**

- Field names are snake_case.
- Money is `{amount, currency}`, with `amount` an integer in minor units. JSON integers are exact up to 2^53, far above any booking.
- Dates are Cairo calendar dates; timestamps are UTC.
- Unknown request fields are refused.
- Passport numbers are write-only; dates of birth are never returned.

Reason: one unambiguous shape for every client.

**2026-10-24 · Webhook signatures.**
Header: `X-VS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Receivers reject timestamps older than 5 minutes.
Reason: the timestamp protects against replays, and the format is the familiar one.

**2026-10-24 · Owner invitations instead of creating Auth users.**
`pnpm platform:create-company` creates the company, its settings, its back-office channel and an owner invitation, all as the admin user. The invited person signs in with that email, as verified by Supabase Auth, and the back office claims the invitation through the allow-listed `vs.claim_staff_invitation` (back office only). One open invitation per email exists across the platform. Invitations expire after 14 days.
Reason: creating Auth users would need the `service_role` key, which rule 7 keeps out of everything except migrations and break-glass.

## Batch 5 (part 2: handlers, webhooks, sandbox)

**2026-10-24 · The idempotency key and its result are stored in the same transaction as the work.**

- `withRequestKey` takes a transaction-scoped advisory lock on (channel, key), so a concurrent duplicate gets `409 IN_PROGRESS` at once.
- It stores the result in the same transaction as the booking work, so a crash after commit never loses it (test 6).
- The same key with a different body is `422`.
- Results replay for 7 days; after that the key is reused as new, and `channel_ref` still finds the booking.
- A replay returns the original operation's result (the same booking, hold or quote), rendered from current state.

Reason: committing the key as `in_progress` in a separate transaction first, as the prompt sketches, can leave a key without its result after a crash.

**2026-10-24 · Access tokens are HS256 JWTs.**
They are signed with `API_TOKEN_SECRET` and carry the API client, company and channel. They live 15 minutes. Client secrets are random 32-byte strings, stored as SHA-256 hashes and compared in constant time; at most two are active per client. The client is looked up through the allow-listed `vs.resolve_api_client` (API role only).
Reason: no token table to query on every call; rotation without downtime.

**2026-10-24 · Rate limit: a Postgres-backed fixed window per minute.**
One row per client per minute (`rate_limit_counter`). The default is 600 per minute, configurable per client. A refused request gets `429` with `Retry-After` set to the seconds left in the minute. Old windows are pruned hourly.
Reason: the prompt allows a Postgres counter, and it needs no Redis.

**2026-10-24 · The event feed and webhooks read below a safe horizon.**
Both return events in `(txid, seq)` order and only below `pg_snapshot_xmin(pg_current_snapshot())`.
Reason: a transaction that started earlier but commits later can never fall behind a cursor.

**2026-10-24 · Which events a channel sees.**
Its own bookings and holds (by `channel_id`), plus availability and sailing changes for its contracted vessels and categories, and rate changes for its contracted plans. Allotment buckets emit no availability events, so other channels' allotments stay invisible.
Reason: spec § Contract enforcement.

**2026-10-24 · Webhook delivery.**

- One delivery per endpoint × event; every attempt is recorded in `webhook_attempt`.
- A delivery is due only when no earlier event of the same resource is still pending for that endpoint, so each resource arrives in order.
- Backoff is 1, 2, 4 … minutes, at most 2 hours. A delivery is dead 24 hours after its first attempt.
- Endpoint secrets are encrypted with the field keyring.
- A new endpoint starts at the current end of the feed (no back-fill).

Reason: spec § Events and webhooks.

**2026-10-24 · Contract enforcement in the API.**
The engine already enforces vessels, categories, rate plans, allocation, stop-sell and TTLs. The API adds three things:

- Ownership: another channel's hold, offer or booking is `404`, so its existence does not leak.
- Channel-aware availability: the channel's own allotment plus the pool, capped by `visible_free_cap`.
- Strict bodies: unknown fields, for example a `ttl_minutes` on a hold, are refused with `400`.

Reason: TTLs come only from the contract, never from the caller.

**2026-10-24 · The sandbox is a company created with the platform command.**
"Sandbox Nile Cruises" runs the demo vessel, pricing and schedule, plus a nilecrz client (`pnpm sandbox:setup`). On the hosted project it needs `--confirm-hosted`.
Reason: the sandbox behaves exactly like a real company, and its data stays isolated by RLS.

**2026-10-24 · The fast phone booking is one engine call over the existing steps.**
`staffBook` runs quote → option hold → confirm (or quote → request on an on-request contract). Each step keeps its own transaction and derives its request key from one key per form submission (`<key>:quote`, `<key>:hold`, `<key>:confirm`). A double click or a retry returns the same booking. When the confirmation is refused, the option hold is released at once rather than left to expire.
Reason: no second write path for bookings, and the screen stays a single click.

**2026-10-24 · Staff edit guests without seeing passport numbers.**
Passport numbers are write-only in the back office: staff see "on file", never the number. A guest edit can name an existing guest (`keepPassportOf`) to keep their encrypted passport when no new number is typed. Otherwise replacing the guest list would silently drop it. The audit log records counts only.
Reason: rule 9 (passports encrypted, never shown or logged), without forcing staff to retype passports.

**2026-10-24 · The deposit is due on the Cairo booking date (bug fix).**
The booking view took the deposit date from the UTC day of `created_at`. Between midnight and 02:00/03:00 Cairo time it therefore showed the deposit as due "yesterday". It now uses the Cairo calendar date, and a regression test covers it.
Reason: business dates are Cairo dates (spec § Time).

**2026-10-24 · A schedule change is previewed by running it and rolling it back.**
`previewScheduleException` applies the real change inside a transaction. It reads the touched departures, bookings, holds and allotments, then rolls everything back (events and audit included). The preview cannot drift from what applying would do.
Reason: spec § Schedule exceptions asks for an impact preview, and a separate "what would happen" calculation would be a second implementation to keep in step.

**2026-10-24 · Templates, itineraries, seasons and policies are shown, not edited, in the MVP screens.**
The schedule screen shows templates and itineraries. Departures are fully actionable: cancel, move, change port, dry dock (each with a preview), and extend the schedule. The rates screen edits rates and adds supplements, and shows seasons and policies read-only. Creating a new template, itinerary, season or policy stays with the setup script (`createScheduleTemplate`, `createSailingPattern`, `createSeason`, … in the engine). Editors for these are in the backlog.
Reason: these are set up once per vessel and season, while rates and departures change weekly. Scope discipline (rule 12).

**2026-10-24 · Each test file checks the invariants of the operators it created.**
The after-file hook and the "clean database" test now look only at the test file's own operators (tracked by `createOperator`). Vitest runs files in parallel, and some files corrupt counters on purpose to prove detection, so a cluster-wide check could fail a file for another file's deliberate damage. The nightly job still checks every operator. The webhook test now runs the job until the event clears the feed horizon, since any transaction open elsewhere rightly holds it back for a moment.
Reason: rule 6 stays per file and deterministic.

**2026-10-24 · Staff, invitations and company defaults are managed in the back office.**
The owner invites people by email with a role, changes roles, deactivates or reactivates them, and revokes open invitations. An invitation is revoked by expiring it, since the table forbids deletes. The company always keeps at least one active owner: the check locks every active owner row, so two demotions at once cannot both pass. Company name, default language and the hold, SLA, cut-off, release and retention defaults are editable. The booking-reference prefix is fixed once bookings exist.
Reason: spec § Settings. Defaults apply to new holds, requests and contracts only.

**2026-10-24 · Secrets are shown once, in a modal.**
New API client secrets, rotated secrets and webhook signing secrets appear once, in a dialog with a copy button. Lists show only the last four characters and when each secret was last used.
Reason: rule 9. A banner at the top of a long page scrolls out of view on a phone.

**2026-10-24 · Physical cabins are assigned per leg, on the booking line.**
`booking_line.assigned_cabin_id` has a unique index per leg (confirmed lines only), so the database itself prevents two parties in one cabin on one leg. A released line (cancellation or amendment) frees its cabin. A party keeps one cabin for its whole cruise when one is free on all its legs. Otherwise it gets a cabin per leg, reported as "split". Only cabins of the booked category qualify; an upgrade is an amendment. Assignment takes the vessel lock, like schedule changes. The `assign_cabins` job runs daily for departures inside the cut-off, and staff can override any assignment.
Reason: spec § Guests, assignment and manifests. A per-booking assignment could not stop two parties sharing a cabin on an overlapping leg.

**2026-10-24 · Manifests and rooming lists are per departure (leg).**
They list who is aboard while the vessel sails from one port to the next, including guests whose cruise started earlier or ends later.
Reason: that is the list port authorities and the crew work from.

**2026-10-24 · Documents are rendered by the worker and stored for a short time.**
Staff request a document, and the back office queues `render_document` through `vs.enqueue_document`. That SECURITY DEFINER function accepts one task, only for a pending document of the caller's own company, and the back office has no other access to the queue. The worker renders PDFs and PNGs with headless Chromium (fonts embedded, no network) and spreadsheets with ExcelJS, then stores the file in `vs.document`. The screen polls the status, then downloads through `/api/documents/[id]`, which runs the same session, MFA and permission checks.
Manifests are the only export with passport numbers. Only owner and reservations may request them, each download is audited, and they are deleted after a day. Other documents are kept for a week.
Reason: spec § Documents and § Sensitive data. Chromium shapes Arabic correctly, which PDF libraries do not reliably do.

**2026-10-24 · Passport numbers and dates of birth are erased after the retention period.**
The daily `erase_passports` job clears them the configured number of days after disembarkation (90 by default). Names stay, and the run is audited (counts only).
Reason: spec § Sensitive data. It is a hard requirement once manifests export passports.

**2026-10-24 · The itinerary is built day by day from the schedule template.**
It walks the template stops from embarkation to disembarkation, into the next cycle when the cruise wraps round, and groups the calls by cruise day. The emergency phone and the voucher note (boarding point, instructions) are company settings shown on every voucher. Resident and Egyptian rates add the ID-at-embarkation note.
Reason: spec § Documents (voucher contents).

**2026-10-24 · The temporary `/progress` page is removed.**
The Batch 6 screens replace it: Today, inventory, bookings, schedule, guests and the vacancy sheet. `getOverview` is gone with it.

**2026-10-24 · Screens are checked at 375 px in both languages by a script, and the phone booking is timed.**
`pnpm --filter @vs/backoffice screenshots` signs in as the demo owner and captures every screen in Arabic and English at 375 px. It fails if a page scrolls sideways or has the wrong text direction. The images go to `docs/screenshots/batch-6/` and are not committed. `pnpm --filter @vs/backoffice usability` plays a phone booking at human pace (about 1 s per tap, about 8 characters a second): 9.6 s and 6 taps locally, against the 60 s target. Itinerary chips on the booking screen keep the sailing list short on a phone.

**2026-10-24 · Arabic screens use Arabic-Indic digits everywhere.**
The back office formats with `ar-EG` (the language cookie stays `ar`; code checks `startsWith('ar')`), and numeric placeholders in the Arabic messages are `{x, number}`. Counts, times and percentages now match money and dates, which already used `ar-EG`.

**2026-10-24 · Erasing a guest keeps the guest row and blanks the personal data.**
An owner can export everything held about one guest (a JSON file, passport included, since the request comes from that person) or erase it. Erasure replaces the name with "Erased Guest" and removes nationality, date of birth and passport, so the cabin's occupancy and the booking's accounts still add up. Both actions are audited without values.
Reason: spec § Data subject requests. Deleting the row would change the booked occupancy that prices and manifests depend on.

**2026-10-24 · Error tracking is Sentry, optional by configuration; alerts are tracked messages from a worker job.**
`SENTRY_DSN` turns it on for the API, worker and back office. The SDK collects no user data, cookies, headers, query strings or bodies, and a scrubber deep-redacts everything else. Only unexpected errors are sent: domain refusals are normal answers. The five alert conditions are checked every 5 minutes per company. Each one is logged at error level and sent as `alert:<name>`, with one fingerprint per alert so Sentry groups the repeats. No extra service runs: the queries use the existing database.
Reason: spec Batch 7 § Observability.

**2026-10-24 · The outage pack carries manifests without passport numbers.**
The nightly `outage_pack` job (02:00 UTC) builds one PDF per active vessel: 14 days of free cabins, then each departure's guests with cabin, category and nationality. It is stored as a document (kept a week; staff can also make one now from the vacancy page) and emailed to the company's operations address when `SMTP_URL` is set. Passport numbers are left out because the pack travels by email: the passport manifest stays a one-day download behind the `manifests` permission. The API's outage behaviour (503 with `Retry-After: 30`) now has its own test against an unreachable database.
Reason: spec § Availability (fallback for staff) and § Sensitive data.

**2026-10-24 · The pilot import books through the engine and reports instead of forcing.**
`pnpm --filter @vs/engine import-bookings --company <slug> --file <csv> [--dry-run]` reads `docs/pilot/import-template.csv` (one row per cabin; rows share `external_ref`). Each booking goes through `staffBook` with today's contract and rates. A differing agreed total is reported, not imposed. A `paid_amount` is recorded as one payment, which confirms a prepaid direct booking once it covers the deposit. Unknown codes, a missing sailing and no room are reported per booking. A second run skips bookings already imported (same external reference on the same channel). `--dry-run` prices everything and books nothing.
Reason: spec Batch 7 § Pilot import. Rule 1: no second write path, even for a one-off.

**2026-10-24 · The pilot dashboard is owner only and reads live data.**
`/pilot` shows the invariant check for the company, oversold buckets (must be 0; emergency-block overcommit is shown apart, since it is covered and sales are stopped), request response times (median and 90th percentile, from the audit log), open exceptions and 30-day bookings by channel.

**2026-10-24 · The restore drill is a logical dump and restore; PITR is still to be enabled.**
The hosted project has daily physical backups, and point-in-time recovery is off (a paid add-on). The drill dumped the application schemas and restored them as `vs_owner` into a scratch database. It was run against hosted (schema only, since there are no companies yet) and against the local database (1,034 companies). Counts, policies, grants and the invariant check matched. The steps and timings are in the runbook. A restore into a second Supabase project, and enabling PITR, need account changes: they are on the go-live checklist.
Reason: spec Batch 7 § Backups.

**2026-10-24 · A public website and docs, named Riverdesk.**
You chose the public name **Riverdesk** ("vessel-system" stays the code name), cruise companies as the main audience, Arabic and English, and docs in four parts: getting started & admin, staff guide, Channel API guide, concepts & glossary.

- **The app:** `apps/website` is its own Next.js app, statically rendered, with no database or secrets, so it can be hosted anywhere public. The language is in the URL (`/ar`, `/en`), so pages can be shared and indexed.
- **The docs:** Markdown in the repository, reviewed like code. Screenshots are real back-office screens of the demo company.
- **Arabic:** the docs were translated from the English using the back office's own Arabic labels. Doing that showed the app used two Arabic words for guests and two names for Guests & manifests. Both are now unified (ضيوف, «الضيوف والكشوف»).
- **First sign-in:** the two-step screen now prints the setup key under the QR code, for people who type it instead of scanning.
- **Not built yet:** a contact form and analytics. "Request a demo" is a mailto link, shown only when a contact email is configured.
  Reason: the user asked for a homepage, a presentation of the application and detailed docs (2026-10-24). It is outside the MVP spec but explicitly requested.

**2026-10-24 · Hosting on Railway: four services from one repository.**
You chose Railway. The website, back office, API and worker each run as a Railway service, built from their own recipe in `deploy/<service>.Dockerfile` and configured by `deploy/railway.<service>.json` (build, health check, restart on failure). The database stays on Supabase (EU). Each image installs only its app and the workspace packages it uses. `.dockerignore` keeps every `.env` file out of images, and secrets reach the services only as Railway variables.

- **API and worker** run their TypeScript with `tsx`, which is now a dependency of both. Bundling them is still in the backlog: it is not needed for correctness.
- **The worker image** installs Chromium for the PDFs.
- **The back office** has `/api/health` for Railway's health check.
  Step-by-step instructions are in `docs/deploy-railway.md`.
  Reason: your choice of provider (2026-10-24). One provider for every program keeps deploys, logs and rollbacks in one place.

## Platform area and password emails (2026-10-24)

- The platform owner works in `/platform` inside the back office rather than in a separate app: one deployment, one sign-in. Access is an email list in `platform.admin` (schema `platform`, owned by `vs_owner`, no grants to runtime roles), maintained with `pnpm platform:add-admin`. Two-step sign-in is always required there.
- The back office reaches platform data only through four allow-listed SECURITY DEFINER functions (`vs.platform_is_admin`, `vs.platform_companies`, `vs.platform_create_company`, `vs.platform_reinvite_owner`, back office only). Each checks the admin list first. The company list returns counts only. The admin's email comes from the verified session, the same trust as `vs.claim_staff_invitation`.
- Company creation lives in one SQL function, `platform.create_company`, used by both the command and the platform area.
- Invited people create their own password at `/signup`. Supabase's email confirmation proves they own the address before the invitation is claimed. Forgotten passwords use Supabase's reset email. Both use PKCE links through `/auth/callback`; no `service_role` key is involved.

## Batch 8, step 1: Ships & cabins screen (2026-10-24)

- Companies set up their own fleet on **Ships & cabins** (`/fleet`): ships, cabin categories and cabins. It reuses the engine's setup functions; no migration was needed.
- Who may change what: ships and categories need the new `fleet.write` (owners). Adding cabins keeps `inventory.write` (owners and reservations), the same rule as the existing cabin card on Inventory.
- Codes (ship, category) cannot change after creation: they appear in references, exports and the Channel API. Names, type, guest limits, deck, view and beds can.
- A category's guest limit can only go down when no booking still to sail (requested, held, offered or confirmed) has more guests than the new limit. Short-lived holds are not checked: they expire within minutes.
- Many cabins are added in one transaction (`addCabins`, up to 200, typed as ranges like `101-120`): all or none. A number already on the ship refuses the whole batch and lists the numbers. Each cabin goes through the same capacity change as one cabin, so a ship that already has departures gets its availability raised on every later leg.
- In Arabic the app keeps «المركب» for a vessel, as on the other screens.

## Batch 8, step 2: ports, routes and itineraries (2026-10-24)

- Set up on the **Schedule** screen, under the departures: **Routes** (schedule templates) with their **itineraries** (sailing patterns), and the company's **Ports**. Owners only (`schedule.write`). No migration was needed.
- A route's stops, cycle and first date can change only while it has no itineraries and no departures; until then it can also be deleted. After that only its name and end date change, so nothing already sold moves. A different route = end the old one, add a new one.
- Itineraries: names and pause (`active = false`: no new sailings; existing ones stay on sale) at any time; delete only without sailings and without package rates.
- A port on a running route (active, not ended) cannot be retired. "Add the usual Nile ports" adds the nine demo ports the company does not have yet.
- The stop rules return codes (`first_stop_day0`, `cycle_returns`, …) instead of English sentences; the back office translates them. The route editor fixes day 0 and the closing stop (same port, last day, boarding) so most mistakes cannot be typed.
- The editor's single **Board / leave** tick sets both flags (`embark_allowed`, `disembark_allowed`); routes with only one of them can still exist and are shown as boarding stops.
- Arabic terms follow the docs: route = «المسار», itinerary = «خط السير».

## Batch 8, step 3: seasons and policies (2026-10-24)

- On **Rates & policies**: **Seasons** for the selected ship, and the company's **Cancellation**, **Children** and **Payment** policies, replacing the read-only cards. Owners only (`rates.write`). No migration was needed.
- Policies are edited in place: quotes and bookings already keep a copy of their policies (`quote.policies`, revision snapshot), so an edit changes new quotes only. A test proves an existing quote keeps its terms.
- Every season or policy change bumps the affected rate plans' `version` and emits `rate.changed` (with a `cause` in the data), like a price change, so channels refresh. Season changes touch every plan of the ship; a policy change touches the plans using it.
- Seasons: code fixed after creation; dates replaceable; overlapping dates refused (also within one season); delete only without rates or quotes. The card lists **sailings whose start date no season covers** (from today), since a sailing is priced with the season of its embarkation date and those cannot be priced. (The first version counted uncovered nights; corrected the same day.)
- Child bands: the editor types only each band's last age, so bands cannot leave gaps; the engine still checks coverage (`bands_gap`, `bands_end`).
- Cancellation: a 0-day step is required; days must differ. Amendment fees are edited with the policy.
- A policy used by a rate plan cannot be deleted. Errors return stable reasons the screen translates.

## Batch 8, step 4: rate plans, supplements and the getting-started checklist (2026-10-24)

- On **Rates & policies**: **New rate plan**, **Edit plan** and **Delete plan** for the selected ship; supplements can now be edited and deleted. Owners only (`rates.write`). No migration was needed.
- A plan sells only through the contracts that list it. **Sell in the back office** (on by default for a new plan) creates the ship's back-office contract when missing (pool, guests pay the company, every category, from today, holds from the company settings) and adds the plan. Before this, a new company could not sell from the office at all: the Channels screen does not offer back-office contracts. Editing a plan sets which of the ship's contracts sell it; a contract must keep at least one plan.
- A new cabin category joins every active contract of its ship, as the contract form already promises ("all cabin categories of the vessel are included").
- Once a plan has prices, its market, currency, per person/per cabin and per night/per package are fixed. Name, board, minimum nights, policies, inclusions, channels and on-sale can change. Delete only without prices, supplements, quotes or bookings.
- Every plan or supplement change bumps the plan and emits `rate.changed`.
- **Getting started** on Today (owners): for each active ship, ten steps in order with links (categories, cabins, route, itineraries, departures, seasons covering every sailing date, policies, a plan, every price, sold in the back office), plus inviting the team and the operations email. "Every price" = each active plan has a price for every category × season, × basis for per-person plans (single, double, triple up to the category's adults) and × active itinerary for package plans. It hides once all is done.
- A test builds a company from nothing through these functions and gets a back-office quote at the end.

## Batch 8, step 5: staff cabin map (2026-10-24)

- On **Guests & manifests**, a **List / Cabin map** switch per departure. The map shows every cabin of the ship deck by deck (decks ordered by their lowest cabin number, not by name): free, guests (lead name, party size, boarded earlier / stays on), blocked (with the reason), out of service. Per category, the free / held / booked counts from the pool. No passport numbers or dates of birth.
- Moving guests reuses the existing `cabinOptions` and `assignCabin` (owners and reservations, `guests.assign`): pick a party, the cabins that fit every night of its cruise light up, one click moves it for the whole cruise. Sales stay by category; holds and allotments are counts and have no cabin.
- Engine: `getCabinMap(legId)` (backoffice/cabin-map.ts). No migration.
- The list of fitting cabins is refetched after every move (a cached answer offered the party's own cabin).

## Markets list and more currencies (2026-10-24)

- Migration 0011: `vs.market` (tenant table: code, English and Arabic names, `needs_residency_proof`, active, order). A trigger gives every new company International (no proof) and Egyptian resident (proof); existing companies were backfilled, plus any market a rate plan already used. Rate plans, quotes, bookings and the Channel API keep naming markets by code (no foreign key), so nothing changes for nilecrz.
- **Settings → Markets** (owners, `settings.write`): add, edit, stop offering, delete when no rate plan, quote or booking used it. The code is fixed. New and changed rate plans must name an offered market (`unknown_market`); an existing plan may keep a market that was switched off.
- Vouchers' "bring proof of residency or ID" line now comes from the market's setting (was: every market but International). New booking shows the same note.
- Currencies: SAR, AED, QAR, CHF, CAD, AUD (2 decimals) and KWD, BHD, OMR (3 decimals) next to USD, EUR, EGP, GBP. One table in `@vs/shared/money` (`decimalsOf`, `minorToDecimal`, `decimalToMinor`, exported to the browser as `@vs/shared/money`) drives the back-office formatting and price fields, PDFs and the bookings import; amounts stay integer minor units (1.250 KWD = 1250). The API's Money is already minor units with any 3-letter code.
- Each rate plan has its own currency, so each market can be sold in its own currency; amounts are never converted.
- Fixed while testing: after creating a rate plan, the Rates screen now selects the new plan once the list has it (it fell back to the first plan).

## Pick lists instead of typing (2026-10-24, user request)

- A shared **pick-or-type** field (`ChoiceField`): the usual answers in a list, plus **Other…** to type one. Used for a category's deck, view and beds and the deck of new cabins (with the ship's own deck names added), and for every reason field: schedule changes, blocks, cabin changes, cancellations, declined requests and payment reversals.
- Deck, view and beds are stored in English (as agencies and vouchers read them) and shown in the screen's language; a typed value is shown as typed. Reasons are stored as the words picked.
- Nationality is a country list (names from the browser in Arabic or English, the usual guest countries first); the guest record keeps the 2-letter code, so nothing changed underneath.
- **Start from** lists fill a new port (19 Nile ports, including Lake Nasser stops), market (8 common markets with their usual proof setting) or season (8 usual names) with code and both names, still editable.
- The browser tab now says Riverdesk, and new authenticator entries are named Riverdesk.

## Grouped menu (2026-10-24, user request)

- The back-office menu is grouped: Today on its own, then **Reservations** (New booking, Bookings, Requests, Payments), **Operations** (Inventory, Guests & manifests, Vacancy sheet), **Setup** (Ships & cabins, Schedule, Rates & policies, Channels) and **Company** (Settings, Pilot); Platform at the end for platform admins. Icons from `lucide-react` (only the ones used are bundled).
- Sections fold; the choice is kept per computer (`localStorage`), and opening a page unfolds its section (since 2026-10-25 a section can be folded while you are on one of its pages). Requests shows how many are waiting. The top bar shows where you are (section › screen); the company name with the Riverdesk mark heads the menu, and the user, role and Sign out sit at its foot.
- Country names are now built in the browser only: the server's and the browser's Intl data spell some names differently, which made New booking re-render (hydration mismatch).

## Website redesign, guides and the unpaid-booking hold (2026-10-25, user request)

- The public website and docs were redesigned (Inter + Tajawal for Arabic, a Nile palette, icons, framed screenshots), with docs search, an outline, callouts and eight bilingual step-by-step guides. The owner supplied the Arabic wording of the marketing pages, Getting started and the guides; "شركات المراكب النيلية" and "الشركات" are the agreed terms.
- One unpaid-booking hold: a prepaid (direct) booking keeps its cabins for the company's **Unpaid booking held** setting (`operator_setting.payment_hold_hours`). The payment policy's bank-transfer and card holds were stored but never what staff set in Settings; migration 0012 drops them. Holds already running keep their expiry.

**2026-10-26 · Pilot requests go through a website-only database role.**
The website had no backend. The /pilot form posts to `POST /api/pilot` on the website itself, which logs in as a new role, `vs_website`, with no table rights at all: it may only call `vs.submit_pilot_request`. Requests are platform data, so they live in `platform.pilot_request`, readable only as `vs_owner`. The function enforces consent and a rate limit (3 an hour, 10 a day per client), keyed on an HMAC of the visitor's IP (key: the role's password) so the address itself is never stored. `vs_website` is a login role but not one of the tenant runtime roles, so the tenant-isolation checks do not apply to it; `check-roles` checks it has no table rights instead.

## Batch D1 — branding

**2026-10-26 · Branding lives in its own table.**
`vs.operator_branding` holds the two colours, the logo (PNG or JPEG ≤ 200 KB, type read from the file's first bytes, not the browser) and the contact block. It is apart from `operator_setting`, which is read on every request, so logo bytes load only for documents and the Branding screen. A company without a row uses the defaults (`#165a5c`, `#c58b3c`, no logo). Removing a logo is an update, not a delete.

**2026-10-26 · Any colour is allowed; text in it is made readable.**
Text printed in a brand colour is darkened until it reaches WCAG contrast 4.5:1 on white; filled table heads pick white or dark ink. Light tints for table heads and notes are mixed from the same colours (`@vs/shared/color`).

**2026-10-26 · Templates moved to `@vs/documents`.**
The HTML templates, wording and fonts left the worker for a package the worker and the back office share, so the Branding screen's preview is the real voucher template with made-up guests (in a sandboxed frame), not a mock. Fonts are read by path from that package's dependencies because the back office's bundler cannot follow `require.resolve`.

**2026-10-26 · Bilingual documents (`both`).**
Arabic first and right-to-left, with the English beneath every heading and label; data with both languages (ports, categories, inclusions) shows both. Dates and numbers use Latin digits, which both readers share. Spreadsheet headers read «عربي / English».

## Batch D2 — check-in

**2026-10-26 · Check-in marks belong to the booked cabin on a departure, not to the guest.**
A booking's guests are replaced as a list whenever they are edited, so marks kept on guest rows would vanish. `vs.checkin` has one row per booked cabin boarding a departure (passports seen, cards signed, key handed, checked in at).

**2026-10-26 · Who "boards" a departure.**
A cabin boards a departure when its booking's sailing starts there (same date and port). Guests already aboard from an earlier departure are on the manifest, not on the embarkation sheet.

**2026-10-26 · Check-in details and their protection.**
All optional. Visa numbers and medical notes are encrypted like passport numbers and never returned to the screen (an existing guest keeps them through `keepPassportOf`). Every personal check-in detail is erased with the passport after disembarkation and on a guest's erasure request; names and nationality stay. Dates of birth stay unencrypted, as before, because age checks need them; they are erased on the same schedule.
Passport warnings: no number on file, expired, or expiring within six months of the end of the cruise.

**2026-10-26 · The on-board role.**
`onboard` belongs to exactly one vessel (`staff_user.vessel_id`, carried by `resolve_staff` and `claim_staff_invitation`). It may open only Check-in for that vessel, tick guests in and download that vessel's check-in documents (passport numbers included); balances are left out of its embarkation sheet and screen. The vessel is enforced in the engine on every read and write, and an on-board login can only follow and download documents it requested itself. Like reservations, it does not require the two-step code (see the open question in the D2 report).

**2026-10-26 · The check-in pack by email.**
The guest details (Excel) and the embarkation sheet, bilingual, emailed to the vessel's on-board address: by button, or automatically N hours before a departure (off until set; needs an email). A departure's moment is its date plus the schedule's boarding time, 12:00 when none is set, in Cairo time. The worker checks every minute; a scheduled send exists once per departure, and every send's outcome is recorded without its content.

**2026-10-26 · Police list columns are provisional.**
The check-in file follows the field list in `documents-plan.md` § 3 until the owner sends a real police list; then its columns are reordered to match.

## Analytics A1.1 — nightly snapshot

**2026-10-26 · Which night a snapshot belongs to.**
The worker runs at 21:45 UTC. The night is the Cairo date of the run time less two hours, so the same night is written whether Cairo is on UTC+2 (23:45) or summer time (00:45 the next day). Re-running a night deletes and rewrites it, so a missed, late or repeated run is harmless.

**2026-10-26 · What a night records.**
`analytics_leg_day`: per departure (up to 400 days ahead) and cabin category, the cabins on sale (pool and allotments), booked, held, blocked (active blocks) and allotted but unsold, and whether sales were stopped. About 460 rows a night for the demo vessel (~170,000 a year). `analytics_sailing_day`: per upcoming sailing, channel, market and currency, confirmed bookings, cabins, guests, cabin-nights, guest value and net value (never added across currencies), open requests and active holds. Only the worker writes them; the back office and API may read.

**2026-10-26 · The one-time backfill.**
A company's first nightly run rebuilds up to 400 past nights from booking dates (counted from confirmation until cancellation; cabins on a departure from booking until release), marked `reconstructed`. Holds, blocks, requests and amendments of those nights are unknown, values use today's booking totals, and capacity uses today's numbers. Screens will mark those nights as estimated.

## Analytics A1.2 — Overview and occupancy and pace

**2026-10-26 · How the A1.2 figures are counted.**
Occupancy is cabin-nights booked ÷ cabin-nights on sale (pool and allotments; blocked cabins are not on sale) over the departures in range, from live inventory. "Booked in a period" counts bookings confirmed in it (Cairo dates), whatever happened later, so a booking cancelled the same week still counts as booked that week. Cancellation rate is cancellations this month ÷ confirmations this month. Requests "answered in time" were accepted, declined or offered before their deadline. A sailing's occupancy counts every booking on its departures, including longer cruises sharing them; its "cabins booked" are its own.

**2026-10-26 · Comparisons with last year.**
The same calendar dates a year earlier (owner's answer). Before the company's first confirmed booking, "last year" has no data and says so instead of showing an increase from zero. The pace chart compares with the sailings of the same vessel that embarked on the same date a year earlier.

**2026-10-26 · Chart colours.**
Charts use two validated colours of their own (colour-blind separation, contrast and chroma, light and dark: #008f8a / #c97416, dark #2aa9a3 / #c27e2c). The brand teal reads as grey in a thin line, so the chart's "this year" is a stronger step of the same hue. The heat map is that one hue from light (empty) to dark (full).

**2026-10-26 · A1.2 filters.**
Vessel and date range only. Channel, market and category filters come with A1.3, where channel and market figures live.

## Analytics A1.3 — channels, markets, booking behaviour, exports

**2026-10-26 · One filter for Channels and Booking behaviour.**
The period is either the booking date (confirmation, Cairo) or the embarkation date, at most 400 days; then vessel, channel, market and cabin category (a booking is in a category when one of its cabins is). Bookings count whatever happened later; cancellations are shown as their own figure. Requests are counted by the date they arrived (or their sailing date); holds by the date they were placed (or their sailing date). Agency allotments are always by departure date.

**2026-10-26 · How the A1.3 figures are counted.**
Per channel: bookings, cabins, cabin-nights, cancelled, requests received → booked with the median answer in minutes, value and value per cabin-night per currency (rounded down to the minor unit on screen). Per market: guests per booking and the share of bookings with children. Allotments: allotted = cabins still in the allotment plus those released back unsold (read from the inventory event written in the release's own transaction); "still open" counts unreleased allotments only. Booking window and cancellation timing use bands of days before embarkation (0–7, 8–14, 15–30, 31–60, 61–90, 91–180, more). Amendments come from booking revisions whose reason is an amendment, with the changes stored in their snapshot.

**2026-10-26 · Excel exports through the document worker.**
Each tab exports as a workbook, one sheet per table, rendered by the worker like every document (queued, audited, kept a week), entity `operator` (migration 0017). Whether money columns are included is decided on the server from the person's role and stored with the request, never taken from the browser.

**2026-10-26 · Occupancy and Overview keep their own filters.**
The Overview has the vessel filter; Occupancy and pace has vessel, start date and length. Channel and market do not apply to capacity, so they are only on the two booking tabs.

## Invoicing F1 — settings, taxes, parties, invoices and credit notes

**2026-10-26 · Answers taken for the invoicing plan.**
The owner asked to keep building without answering `invoicing-plan.md` § 8, so the recommended answers were taken (listed at the top of that plan). Any can still change before the batch that uses it.

**2026-10-26 · Gap-free numbers.**
Invoices and credit notes have their own series per company and year (`INV-2026-00001`, `CN-2026-00001`), from a counter row bumped with `insert … on conflict do update … returning` in the transaction that issues the document. Concurrent issues queue on that row; a failed issue rolls the number back. Postgres sequences are not used because they leave gaps. A company continuing a paper series sets its prefix, digits and first number; these lock once a document in that series is issued, and the base currency locks once anything is issued. Issue dates are always today in Cairo (no back-dating).

**2026-10-26 · An issued invoice is final, in the database.**
Triggers refuse any change to an issued invoice or credit note except its status and the amounts paid and credited, any change to its lines, its deletion, and a return to draft, whoever asks (owner included). Mistakes are corrected with a credit note, full or by line. A fully credited invoice becomes `cancelled`.

**2026-10-26 · What an invoice shows.**
Lines come from the booking's frozen quote, never re-priced: one line per cabin (the sum of the quote lines in its total), an amendment-fee line when the booking has fees, and for agencies on commission contracts the gross with the commission as its own negative line, so the total is what the agency owes. A cancelled booking is invoiced for its penalty (and fees) only. Descriptions are written in Arabic and English. A booking is on at most one open invoice (a draft, or issued and not fully credited).

**2026-10-26 · Who is billed.**
Credit and channel-collected contracts bill the agency: one billing party per channel, created the first time it is invoiced. Direct bookings and vessel-prepaid agency bookings bill the guest, from the lead guest, reused for the booking's later invoices. Issued invoices keep a snapshot of the party and of the company as issuer; editing either later changes nothing issued.

**2026-10-26 · Proformas.**
A proforma «فاتورة مبدئية» has no number, can be drafted for a booking not yet confirmed, and can be edited or deleted by reservations. Issuing it copies it into an invoice (finance only, and only for confirmed, completed or cancelled bookings); the proforma stays as it was.

**2026-10-26 · Taxes and rounding.**
No tax by default. A company may add tax lines (inclusive or on top) and mark one as the default for booking lines. Tax is computed per line, half-up, once (inclusive: amount × rate ÷ (1 + rate)); totals are sums of rounded lines. Lines keep a snapshot of the tax they were issued with; credit notes use the original line's tax, not today's rate.

**2026-10-26 · Currencies.**
An invoice is in its bookings' currency (all bookings on one invoice share it). When that differs from the base currency (EGP by default), issuing needs a typed rate with its source and date, kept on the invoice and reused by its credit notes.

**2026-10-26 · The `finance` permission.**
`payments.write` is renamed `finance` (same holders: owner and finance, both with MFA). It covers payments, issuing invoices and credit notes, finance settings, taxes and party details. Reservations draft proformas. The channel API's database role can read but not write the invoicing tables; it has no invoice endpoints (question 13).

**2026-10-26 · Contract terms for invoicing.**
Contracts gain `credit_terms_days` (an invoice's due date = issue date + N, else the company's default terms) and `contract_ref`. `credit_limit_mode` (block, today's behaviour, or warn) is stored but only `block` is enforced until F4.

## Invoicing F2 — PDFs, register, sharing, Invoices screens

**2026-10-26 · One document kind for invoices, proformas and credit notes.**
`invoice` documents (migration 0019, entity `invoice`) are PDFs in Arabic, English or both, rendered by the worker and kept a week like other documents. An issued document prints its frozen snapshots of the company and the party, so a reprint years later gives the same page; a draft prints today's details under a "Draft — not issued" band. A proforma carries "a proforma is not a tax invoice". Files are named by number (`INV-2026-00042-ar.pdf`) or, before issue, by booking ref. Anyone who can see invoices may print one; it is not a change, so read-only users may too.

**2026-10-26 · What the PDF shows.**
The company (legal name, address, tax and commercial registration numbers) and the party side by side; number, issue and due dates and booking refs; one row per line with its tax rate when any line is taxed; subtotal, one row per tax rate, total; on an invoice, amounts credited and paid and the amount due; the typed exchange rate with the base-currency equivalent; bank details; the invoice note; the tax-authority footer when switched on. Arabic descriptions keep dates and refs left to right with invisible Unicode isolates. Numbers are not written out in words (question 12).

**2026-10-26 · Sharing.**
Share hands the PDF to the phone's share sheet (WhatsApp, e-mail) where the browser supports sharing files, and downloads it otherwise. Copy link copies the invoice's page in the back office, for colleagues who are signed in (question 8). Nothing is sent by Riverdesk itself.

**2026-10-26 · The invoice register.**
An Excel workbook (finance only) of every invoice and credit note issued in a period, by issue date and number: party and its tax number as issued, booking refs, currency, subtotal, tax, total, credited, paid, rate and the total in the base currency. Credit notes are negative, so the base-currency column sums to net sales.

**2026-10-26 · Screens.**
Invoices (under Reservations): a list with type, status and overdue filters, the register, and a manual invoice without a booking for an existing party. An invoice page: lines and totals, the party (editable by finance; issued invoices keep their snapshot), PDF and sharing, linked credit notes; drafts can be edited (language, due date, note, extra lines) or deleted, and issued (with the rate when the currency is not the base); issued invoices get credit notes (whole or by line). The booking page lists its proformas and invoices with Proforma (reservations) and Invoice (finance) buttons. Finance settings (finance only): the company as issuer, bank details, notes, footer, numbering (locked once used), currencies, default terms, and taxes.

## Invoicing F3 — receipts and allocations

**2026-10-29 · Receipts, allocations, credit.**
A receipt (migration 0020) is money received from or paid back to a billing party; an allocation says how much of a receipt pays an invoice, per booking on it (or its manual lines). Both are append-only: a receipt is reversed by an opposite receipt, an allocation undone by a negative one. Only a receipt's photo or PDF (PNG, JPEG or PDF, at most 5 MB, kept in Postgres) can be added or replaced later; a trigger refuses any other change. A party's credit, per currency, is its receipts less its allocations. Invoice `amount_paid` is the sum of its allocations and its status follows (issued, partially paid, paid); a fully credited invoice stays cancelled.

**2026-10-29 · A booking's money and a party's money.**
A payment recorded on a booking writes a receipt for that booking. It pays only that booking's share of its invoices; what is left stays with the booking (refunded from the booking, or taken by its next invoice). A receipt recorded for a party (an agency's remittance) is free credit until allocated. Allocating it spreads it over the invoice's bookings, earliest sailing first, then the manual lines, and writes a booking payment for each, so booking payment statuses stay right. Taking it back off writes an `unallocated` entry in the booking ledger (a new payment kind) and the money is credit again. A payment written by an allocation is undone on its receipt, not reversed from the booking.

**2026-10-29 · When money moves by itself.**
A booking payment recorded while the booking is on an issued invoice is applied to it at once. Issuing an invoice applies its bookings' unused money (deposits) to it. A credit note that leaves an invoice paid beyond what it still bills takes the excess back off it, newest receipt first. Reversing a booking payment reverses its receipt and takes it off its invoices.

**2026-10-29 · Refunds.**
A booking refund also writes a negative receipt, keeps today's refund cap, and is refused for money that still pays one of the booking's invoices (credit the invoice first). A party's free credit is paid back as a negative receipt, at most that credit. Either may name the credit note it pays back.

**2026-10-29 · Receipt methods and existing payments.**
Receipt methods: bank transfer, cash, card, agency remittance, collected by the platform. Migration 0020 gave every billing agency a party, every paid booking a party (its lead guest, or the booking ref until one is entered), every existing payment a receipt (`card_office` and `gateway` → card, `channel` → platform; refunds and reversals as negative receipts), and applied payments of bookings already on an issued invoice to it. Request keys for party receipts are scoped to the agency's channel, else the company's back-office channel.

**2026-10-29 · Screens.**
Payments gets a Receipts tab (finance only): a list with a "money left" filter, Record receipt (party, amount, method, reference, file, and the party's open invoices in that currency filled oldest due first, editable; the rest stays as credit) and Pay back credit. A receipt page shows its allocations, Pay an invoice (with a typed rate across currencies), Take off, Reverse and the file. An invoice page shows what pays it, Record receipt, and Use credit for the party's receipts with money left. The booking payment dialog takes a file for its receipt.

## Invoicing F4 — statements, aging, credit limit, Today

**2026-10-29 · Statements.**
A party's statement for a period, per currency: the opening balance (everything before the start), then every invoice and credit note by issue date and every receipt, refund and reversal by the day received, with a running balance, then the closing balance. What the party owes is positive: an invoice adds its total, a credit note and money received take theirs off, a refund paid out adds it back. Under the closing balance it shows today's open invoices and the money not yet on an invoice; when everything is in one currency, closing balance = open invoices − that money (tested). A PDF in Arabic, English or both (new document kind `statement`, migration 0021, entity `billing_party`) or a workbook. Anyone who can see invoices may read and print one.

**2026-10-29 · Aging.**
Open invoice balances as they stood at the end of a chosen date (credit notes issued and allocations made by then taken off), by days past the due date: not yet due, 1–30, 31–60, 61–90, over 90. One row per party and currency, with the money it had received by then and not yet applied, the net, and totals per currency. On screen and as a workbook (document kind `aging`).

**2026-10-29 · Credit exposure and warn mode.**
An agency's exposure, in its limit currency, is its confirmed bookings not on an issued invoice (total + fees − paid), plus its open invoices, less its money received and not yet on an invoice; bookings and invoices in another currency are not counted. A credit booking that would take it over the limit becomes a request for approval (block, the default) or, on a contract set to warn, is confirmed with `reason: credit_limit_warning`, audited, and the booking page shows the exposure against the limit. A channel without credit, or with its limit in another currency, always gets a request. The mode is chosen on the contract (new contract, or the toggle on an existing one).

**2026-10-29 · Today.**
Four new lists: invoices overdue or due within 3 days, money received from a party and not yet on an invoice (finance only, it links to the receipt), and bookings that embarked in the last 7 days and are on no issued invoice.

**2026-10-29 · Screens.**
Invoices gets Statements (party, period, table per currency, PDF in each language and Excel) and Receivables (aging as of a date, Excel; each party links to its statement).

## Invoicing F5 — finance reports, account codes, accountant exports

**2026-10-29 · Reports.**
Four plain tables (dashboards are analytics A2), on screen and as Excel or CSV (new document kind `finance_report`, migration 0022; `csv` is a new document format): invoiced revenue before tax and gross of agency commission by invoice month × vessel × sailing × channel, net of credit notes, with the commission deducted and the tax beside it; production by embarkation date (booked value — a cancelled booking's penalty and fees — invoiced on issued invoices less credit notes, commission lines left out, and not yet invoiced); collections by month × method (received, refunded, reversed, net); outstanding by party as of a date (from the aging). Filters: period, vessel, channel. Amounts stay in their own currency; no conversion. Anyone who can see invoices may read and download them, like statements.

**2026-10-29 · Account codes.**
`account_mapping` holds the company's codes: receivables, cash, bank, agency commission, tax payable (default and per tax), revenue (default, per vessel, per agency channel). Blank by default; a blank code is simply missing from the journal, and the export lists what is still to set. Finance only, in Finance settings.

**2026-10-29 · Accountant exports.**
Finance only (document kind `accountant_export`), Excel or CSV (UTF-8 with a byte-order mark, decimals with a point): invoices and credit notes (the register's columns; credit notes negative), payments (every receipt, refund and reversal with the invoices it paid), and the journal. Journal: an invoice debits receivables with its total, credits revenue before tax (grouped by vessel and channel; revenue takes the vessel's code, else the channel's, else the default) and tax payable per tax, and debits commission for a commission line; a credit note is the mirror image; money received debits cash (cash) or bank (any other method) and credits receivables, money paid out the reverse. Each entry also carries its amount in the base currency at the invoice's rate; money in another currency than the base has no base amount (it has no rate of its own). Each document's entries balance (tested). The channel API's finance scope (question 13) stays out.

## Invoicing F6 — help pages

**2026-10-29 · Help pages and the demo company's invoicing.**
Four new pages in Arabic and English on the website: Staff guide → Invoices and credit notes, Receipts and credit, Statements and reports; Guides → Bill an agency and record its payment; the Payments page points to receipts. Screenshots are real screens of the local demo company, taken by `pnpm --filter @vs/backoffice guide-shots <name>`. `seed-demo` now also gives the demo company issuer details, agency and platform invoices, a remittance with credit left over, a credit note, a direct guest's deposit applied to their invoice, and a few account codes (once).

**2026-10-29 · Revenue is gross of commission.**
Seen on the real screen: the revenue report counted agency invoices net of the commission line. Revenue is now the cabins, fees and penalties invoiced, before tax and before commission, with the commission deducted in its own column, as the journal posts it.
