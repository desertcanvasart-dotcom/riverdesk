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
