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
