# Nile Cruise Reservation System — Technical Spec v2

Oct 22, 2026 · Faris Hussein

## What changed in v2

v2 makes every inventory movement exact before any code is written. The biggest change: inventory is counted per **leg**, because a 7-night Luxor–Luxor cruise and the 4-night and 3-night cruises inside it occupy the same cabins.

| Area | v1 | v2 | Why |
| --- | --- | --- | --- |
| Inventory unit | Per sailing × category | Per leg × category, in buckets (pool, allotment, block) | Overlapping cruises could sell one cabin twice |
| Holds | Atomic decrement only | Hold state changes conditionally on database time; inventory moves only if it wins | Confirm and expiry could both succeed |
| On request | Held no inventory, unclear acceptance | Acceptance takes inventory atomically or fails; offers carry their own hold | Acceptance could confirm a sold-out cabin |
| Allotments | One ambiguous `cabins` field | Total, held, booked per bucket; each booking records its bucket; release rules defined | Cancellations could return capacity to the wrong place |
| Amendments | Back-office screen only | Engine rule (acquire new, then release old, one transaction) + API | Date and category changes are constant on the Nile |
| Pricing | Rate + supplements + signed token | Stored quote with occupancy, child ages, policies and expiry; snapshot saved on the booking | Child and single pricing drive Nile quotes |
| Payments | Gateway adapter only | Explicit policy: prepaid, deposit, agent credit, late payment | Payment must never confirm a released cabin |
| Charters | Missing | Whole-boat bookings across all legs and categories | Dahabiyas sell mostly as charters |
| Agents | API only | Agent portal in the first release after the pilot | Most agents will log in, not integrate |
| Back office | Reports-led | Daily action list, fast booking, controlled adjustments, editable schedule, documents | Staff need to know what to do today |
| Isolation | RLS | RLS tested with the real API and worker roles; no `service_role` in runtime paths | Supabase's service role bypasses RLS |
| Stack | Redis or materialised views as cache | Postgres + one durable worker; cache only when measured | Fewer moving parts |
| MVP | Core + back office + API | Adds amendments, action list, manual payments, voucher; agent portal next | Pilot must survive real booking changes |

## Scope and the one condition

The vessel system is a standalone, multi-tenant reservation product for Nile cruise operators: a booking engine, a back office, an agent portal and a channel API, all working on one inventory. nilecrz, Autoura and other portals connect to it as channels.

Instant availability works across every channel on one condition: **every booking for the vessel goes through the system**, including phone, WhatsApp and walk-in bookings that staff enter in the back office. A side spreadsheet turns instant confirmation into overbooking.

**Design rules**

- Every inventory movement happens in one database transaction, decided on database time, and can happen only once.
- Every booking records which leg, category and bucket each cabin came from, so every release returns capacity to the right place.
- Retries, duplicates, delays and crashes must never create or lose a cabin. A nightly invariant check proves it.
- Staff work from what needs doing today, not from reports.
- Build only what the pilot vessel needs; everything else waits for a named demand.

## Architecture

The back office, the agent portal and every API channel call the same booking engine, which writes one inventory; one durable worker runs expiries, allotment releases and outgoing events.

```
 VESSEL STAFF           VESSEL SYSTEM · STANDALONE PRODUCT              CHANNELS
 ┌───────────────┐     ┌──────────────────────┐    ┌───────────────┐    ┌──────────────────┐
 │ Back office   │ ◀─▶ │ Booking engine       │ ◀▶ │               │ ◀▶ │ nilecrz          │
 │ phone, walk-in│     │ hold, confirm, amend │    │               │    │ first client     │
 └───────────────┘     └──────────▲───────────┘    │  Channel API  │    └──────────────────┘
                                  ▼                 │               │    ┌──────────────────┐
                       ┌──────────────────────┐    │  REST +       │ ◀▶ │ Agent portal     │
                       │ Inventory + bookings │    │  webhooks     │    │ agents log in    │
                       │ one source of truth  │    │               │    └──────────────────┘
                       └──────────┬───────────┘    │  per-channel  │    ┌──────────────────┐
                                  ▼                 │  terms        │ ◀▶ │ Autoura, others  │
                       ┌──────────────────────┐    │               │    │ REST API         │
                       │ Worker               │ ─▶ │               │    └──────────────────┘
                       │ expiry, release,     │    └───────────────┘
                       │ events               │
                       └──────────────────────┘
```

Channels never touch the database. The channel API and the agent portal apply each channel's contract (vessels, categories, rate plans, pool or allotment, visible-free cap) before calling the engine. Back-office bookings take the same engine path, so a phone booking and a portal booking compete for the same cabins under the same locks.

## Inventory model: legs and buckets

Inventory is counted per **leg × cabin category**. A leg is the stretch between two ports during which a cabin stays with the same guests; a sellable cruise is an ordered run of consecutive legs.

```
Two weeks of one vessel (to scale by nights)

                      | A1 · 4 nights  | B1 · 3 n  | A2 · 4 nights  | B2 · 3 n  |
                      | Luxor→Aswan    | Aswan→Lux | Luxor→Aswan    | Aswan→Lux |
4 nights from Luxor   |[==============]|           |                |           |
3 nights from Aswan   |                |[=========]|                |           |
7 nights from Luxor   |[==========================]|                |           |
7 nights from Aswan   |                |[==========================]|           |

Leg B1: three of these cruises take a cabin from it, so one count per category must cover all three.
```

A 7-night booking takes one cabin on both of its legs, so it competes with the 4-night and 3-night cruises on those legs. Counting per sailing, as v1 did, would sell the same cabin twice.

**Definitions**

- **Leg:** vessel, from port, to port, departure date, arrival date. Generated from the schedule. Typical: leg A Luxor→Aswan (4 nights), leg B Aswan→Luxor (3 nights).
- **Sailing (sellable cruise):** embark port and date, nights, ordered legs. 4 nights = A; 3 nights = B; 7 nights from Luxor = A + B of the same week; 7 nights from Aswan = B + the next week's A. Sailings that span other ports or longer itineraries (e.g., Lake Nasser, Esna–Aswan dahabiya runs) are just different leg sets.
- **Bucket:** a counter for one category on one leg, of one kind: `pool` (shared, sold by any channel allowed to sell from it), `allotment` (one channel's block), or `block` (cabins out of service, with a reason). Each bucket has `total`, `held`, `booked`; free = total − held − booked.

**Invariants** (checked by a reconciliation job nightly and after every automated test)

1. For every leg × category: the sum of bucket totals = the active cabins of that category.
2. For every bucket: `held` = the sum of active hold lines on it; `booked` = the sum of confirmed booking lines on it.
3. 0 ≤ held, 0 ≤ booked, held + booked ≤ total.

Any violation pages the on-call admin and stops sales on that leg and category until resolved.

**Taking inventory**

- A booking of n cabins on a sailing takes n from one bucket on **every** leg of that sailing, in one transaction. If any leg fails, nothing changes.
- Each booking line records its leg, category and bucket, so every release returns capacity to the right place.
- Bucket choice per leg: the channel's allotment bucket if it has free cabins; otherwise the pool, if the channel contract allows pool sales.

**Cabin numbers**

Because every booking covers consecutive legs, a valid cabin assignment always exists while each leg's count fits, provided assignments can still move. So cabin numbers are fixed at an assignment cut-off (default 7 days before embarkation) and not promised earlier. Confirmed but unassigned bookings count as booked: unassigned cabins are not unsold capacity. A guaranteed specific cabin is a later feature (a cabin-level lock the assignment treats as fixed).

## Domain model

Every table carries `operator_id` for tenant isolation, plus `created_at` and `updated_at`. Money is stored as integer minor units with an ISO currency code. Timestamps are UTC; business dates (embarkation, release, penalties) are evaluated in Africa/Cairo.

| Area | Table | Key fields |
| --- | --- | --- |
| Product | `vessel` | name, type (cruise ship / dahabiya / steam), max_guests, sells_cabins, sells_charter |
| Product | `cabin_category` | vessel, code, name, deck, view, bed_config, max_adults, max_occupancy, extra_bed_allowed |
| Product | `cabin` | vessel, category, number, deck, connecting_cabin, accessible, active |
| Schedule | `schedule_template` | vessel, leg pattern (from port, to port, weekday, nights), valid_from, valid_to |
| Schedule | `leg` | vessel, from_port, to_port, depart_date, arrive_date, status (open / closed / cancelled), template |
| Schedule | `sailing`, `sailing_leg` | embark port and date, nights, status; ordered leg ids |
| Schedule | `schedule_exception` | vessel, dates, kind (cancel / shift / port change / dry-dock), reason, status |
| Inventory | `inventory_bucket` | leg, category, kind (pool / allotment / block), allotment or block ref, total, held, booked, version |
| Inventory | `allotment` | channel, vessel, categories, legs or date range, cabins per leg, release_days, status (active / released) |
| Inventory | `cabin_block` | vessel, category, optional cabin, legs, count, kind (normal / emergency), reason |
| Inventory | `inventory_event` | bucket, Δtotal, Δheld, Δbooked, cause, reference, actor, at — append-only |
| Commercial | `channel` | type (back office / agent / portal / API), name, credit_allowed, credit_limit, currency |
| Commercial | `channel_contract` | channel, vessel, categories, rate plans, allocation (pool / allotment / on request), visible_free_cap, markup or commission, hold and option TTLs, request SLA, stop_sell |
| Pricing | `rate_plan` | code, board, market, currency, cancellation, payment and child policies, min_nights |
| Pricing | `rate` | rate plan, category, season, basis (single / double / triple), amount per person |
| Pricing | `child_policy` | age bands (from, to, % of adult or fixed), max children per cabin, sharing rules |
| Pricing | `supplement` | kind (gala / peak / other), dates, amount per adult and per child, mandatory |
| Pricing | `charter_rate` | vessel, season, nights, amount, max_guests |
| Pricing | `cancellation_policy`, `payment_policy` | penalty rules by days before embarkation; deposit %, balance due days, prepaid hold TTL |
| Booking | `quote` | channel, sailing, cabins (category, adults, child ages), market, price lines, policy snapshot, expires_at |
| Booking | `booking` | ref, channel, channel_ref (unique per channel), sailing, kind (cabins / charter), status, revision, totals, payment status |
| Booking | `booking_revision` | booking, rev, full price and policy snapshot, reason, actor |
| Booking | `booking_cabin` | booking, category, occupancy, child ages, assigned cabin (nullable), status |
| Booking | `booking_line` | booking cabin, leg, bucket — the inventory link |
| Booking | `hold`, `hold_line` | kind (checkout / option / offer / payment), status, expires_at; lines: leg, bucket, n |
| Booking | `offer` | request booking, alternative sailing or category, hold, expires_at, status |
| Booking | `guest` | booking cabin, names, nationality, date of birth, passport number (encrypted), lead guest |
| Money | `payment` | booking, kind (deposit / balance / refund), method (gateway / bank / cash / credit), amount, currency, fx_rate, reference, recorded_by |
| System | `idempotency_key` | channel, key, request_hash, status (in progress / done), response |
| System | `event`, `webhook_delivery` | outbox events (id, type, resource, resource_version, payload without personal data); delivery attempts |
| System | `exception` | kind (oversubscription / late payment / schedule change / invariant), references, status, owner |
| System | `audit_log` | actor, action, entity, diff with personal data redacted |

## State transitions and concurrency

Every transition is one transaction that first changes the owning record's state with a conditional update, then moves inventory only if that update succeeded, then writes inventory events and an outbox event. A transition can therefore happen once, and two transitions on the same record can never both win.

```
                 decline                    offer other (takes cabins)
   [Declined] ◀────────── [Requested] ════════════════════════▶ [Offered]
                            ║        ║                              │
           accept · prepaid ║        ║ accept · credit              │ accepted
          (takes cabins)    ▼        ▼ (takes cabins)               ▼
                         [Held] ───────── confirm or pay ──────▶ [Confirmed]
                            │                                       │
                 TTL passes │                                       │ cancel
                            ▼                                       ▼
                   [Expired / released]                 [Cancelled · penalty per policy]

 ═══ takes cabins in one guarded transaction; Expired and Cancelled return them.
 A checkout or option starts at Held. Confirmed ends as Completed after the last leg.
 Amendments keep a booking Confirmed and add a new revision.
```

**Locking, clocks and retries**

- Lock the owning row first (hold or booking), then buckets in one global order: leg departure date, leg id, category id, bucket id. Every job and endpoint uses this order: confirm, expiry, cancel, amend, allotment release, charter.
- Run in READ COMMITTED with explicit row locks (`SELECT … FOR UPDATE`) and conditional updates.
- Retry the whole transaction up to 3 times with jittered backoff on deadlock (`40P01`) or serialization failure (`40001`). After that return `409 RETRY_LATER`.
- Every time check uses the database clock (`now()`), never the application server's.

**Taking cabins from a bucket**

```sql
UPDATE inventory_bucket
SET held = held + :n, version = version + 1
WHERE id = :bucket_id AND total - held - booked >= :n;
-- 0 rows on any leg: abort the transaction, return NOT_AVAILABLE
```

**Transitions**

| Transition | Guard (conditional update) | Inventory effect, per booking line |
| --- | --- | --- |
| Create hold (checkout or option) | Quote valid; contract allows; TTL from contract | held += n on every leg |
| Confirm hold | `hold.status = 'active' AND expires_at > now()` → `confirmed` | held −= n, booked += n |
| Expire hold (worker, every minute) | `status = 'active' AND expires_at <= now()` → `expired`; batches with `FOR UPDATE SKIP LOCKED` | held −= n |
| Release hold (customer abandons) | `status = 'active'` → `released` | held −= n |
| Create request | Contract or category is on request | none |
| Accept request, credit channel | `booking.status = 'requested'` → `confirmed` | booked += n where free ≥ n; if any leg fails, acceptance fails and nothing changes |
| Accept request, prepaid channel | `requested` → `held` with a payment hold (TTL from payment policy) | held += n |
| Decline request | `requested` → `declined` | none |
| Request timeout | `requested` and SLA + grace passed → `expired` | none |
| Offer alternative | `requested` → `offered`; the offer gets its own hold (default 48 h) | held += n on the alternative's legs |
| Accept offer | `offer.status = 'open'` and its hold active → booking moves to the alternative; then confirm (credit) or keep as payment hold (prepaid) | as confirm hold |
| Offer expires | offer hold expires → offer `expired`, booking `expired` | held −= n |
| Cancel | `booking.status = 'confirmed'` → `cancelled`; penalty from the booking's policy snapshot on Cairo date | booked −= n; if the bucket is a released allotment, also move the unit to the pool (below) |
| Complete (worker) | Day after the last leg arrives | none |

**Allotments**

- **Create:** per leg, pool `total −= N` (only if pool free ≥ N), allotment bucket `total = N`.
- **Release** at `embark_date − release_days`, 00:00 Cairo, per leg: unused = total − held − booked; allotment `total −= unused`, pool `total += unused`; mark the allotment leg released.
- **After release,** any unit leaving the allotment bucket (hold expiry, cancellation) also moves its `total` to the pool in the same transaction.
- **Release vs cancellation:** both lock the allotment bucket row; whichever runs second sees the released flag and applies the after-release rule. Capacity is counted once.
- **Reducing an allotment early** takes only its unused cabins.

**Amendments**

- Kinds: change sailing or date, change category, add or remove cabins, change occupancy or child ages, change guest details (no inventory).
- The client sends the booking revision it is amending (`If-Match: <revision>`); a stale revision returns `409 REVISION_CHANGED`.
- In one transaction: compute the required cabins per leg × category for the new version against the current booking lines; **acquire every increase first** (booked += n, conditional); then release every decrease; price from an amendment quote; write a `booking_revision`; increment the revision; emit `booking.amended`.
- If any acquisition fails, abort: the booking and inventory are unchanged.
- Lines on unchanged legs keep their bucket. Fees for removed nights or dates follow the policy snapshot (e.g., removed nights inside the penalty window are charged as a cancellation).

**Charters (whole boat)**

- A charter is a booking of kind `charter` on a sailing. It is on request only and accepted by staff.
- If any allotment exists on those legs, staff must release it first (channels are notified).
- Acceptance locks every bucket on every leg of the sailing (all categories, standard order) and requires held = 0 and booked = 0 in all pool and allotment buckets. It then sets pool `booked = total` and writes one booking line per leg × category.
- Cancelling a charter returns every line. A sailing with any cabin sold or held cannot be chartered.

## Pricing and quotes

Every price is computed server-side into a stored quote, and the accepted quote is copied onto the booking as a snapshot. A booking is never repriced unless it is amended.

**Price of one cabin**

1. **Adults:** the rate for (rate plan, category, season of the embark date, market) at the occupancy basis: single (includes the single supplement), double (per person) or triple (per person). Reject occupancies the category does not allow.
2. **Children:** each child is priced by the rate plan's child policy, by age on the embark date. Example policy: 0–5 free, 6–11 at 50% of the adult double rate when sharing with two adults, 12+ priced as an adult. Max children per cabin and whether a child in their own cabin pays the adult rate come from the policy.
3. **Supplements:** add every supplement whose date falls inside the sailing (gala dinners on 24 and 31 December, peak dates), per adult and per child as defined.
4. **Channel rule:** apply the channel contract's markup, or net plus commission.

**Charters:** price = the charter rate for (vessel, season, nights), capped at the vessel's `max_guests`, plus supplements per guest. No per-cabin pricing.

**Market:** taken from the lead guest's nationality and residency. Resident and Egyptian rates require ID at embarkation; the voucher states this, and staff can reprice a booking whose guests cannot show it.

**Quote contents** (the `quote` row; the API returns its id, signed)

- Channel, sailing, each cabin's category, adults, child ages, market, currency.
- Line prices: per guest, per supplement, channel adjustment, totals.
- Snapshots: cancellation policy, payment policy (deposit, balance due), child policy, inclusions and exclusions.
- `expires_at`, never shorter than the hold TTL it will be used with.

**Rules**

- A hold must reference a valid quote for the same channel, sailing and occupancy; otherwise it is rejected.
- Confirming copies the quote into a `booking_revision`. Amendments create a new quote and a new revision; earlier revisions are kept.
- Rate changes never affect existing quotes or bookings.

## Payments policy

A payment can confirm a booking only while that booking still holds its cabins. Each channel contract picks one of two payment modes.

| Mode | Used by | When it is confirmed | Money |
| --- | --- | --- | --- |
| Prepaid | Direct guests, portals that collect payment (e.g., nilecrz) | When the deposit (or full amount) is received while the payment hold is active | Deposit % at booking; balance due N days before embarkation (payment policy) |
| Credit | Contracted agents | On confirmation, without payment | Billed on a monthly statement; due per agent terms |

**Prepaid rules**

- The payment hold's TTL comes from the payment policy (default 24 h for bank transfer, 30 min for card checkout).
- **Payment arrives while the hold is active:** confirm the hold and record the payment, in one transaction.
- **Payment arrives after the hold expired:** try to take the cabins again (same transition as a new hold, then confirm). If that succeeds, confirm. If not, set the booking to `paid_unavailable`, create an exception on the action list, and notify the channel. Staff offer an alternative or refund. Never confirm without cabins.
- **Balance overdue:** shows on the action list from the due date. Automatic cancellation is off by default; when enabled per policy, it runs N days after the due date with notice to the channel first.

**Credit rules**

- Each agent channel has a credit limit. At confirmation, if unpaid confirmed bookings plus this booking exceed the limit, the booking becomes a request for staff approval instead.
- Monthly statement per agent: bookings, cancellations with penalties, payments received, balance.

**Recording payments**

- MVP: staff record payments by hand (bank transfer, cash, card at office, agent remittance) with amount, currency, exchange rate if different from the booking currency, reference and date. Every entry is audited and can only be reversed by a new entry.
- Later: a gateway adapter (an Egyptian gateway for EGP and local cards; an international acquirer for foreign cards) writes the same `payment` records through webhooks, verified by signature, idempotent on the provider reference.
- Refunds are calculated from the policy snapshot and recorded as negative `payment` entries.

## Channel API v1

One versioned REST/JSON API (OpenAPI 3.1 is the contract), with channel contracts enforced from the first release even while nilecrz is the only client.

**Endpoints**

| Method | Path | Does |
| --- | --- | --- |
| GET | /v1/vessels | Vessels, categories, occupancy rules and media this channel may sell |
| GET | /v1/sailings?vessel=&from=&to=&nights= | Sailings with their legs |
| GET | /v1/availability?vessel=&from=&to= | Per sailing × category: status (instant / on_request / sold_out), free capped by contract, from-price, `as_of` |
| POST | /v1/quotes | Price one sailing for given cabins, adults and child ages; returns quote id, lines, policies, expiry |
| POST | /v1/holds | Hold cabins from a quote; returns hold id and expiry |
| POST | /v1/holds/{id}/confirm | Confirm with guest details |
| DELETE | /v1/holds/{id} | Release a hold |
| POST | /v1/requests | Create an on-request booking from a quote |
| POST | /v1/offers/{id}/accept | Accept an alternative offered by the vessel |
| GET | /v1/bookings/{ref} | Booking, current revision, status, payments due |
| POST | /v1/bookings/{ref}/amendment-quotes | Price a proposed change |
| POST | /v1/bookings/{ref}/amendments | Apply it (`If-Match: <revision>`) |
| POST | /v1/bookings/{ref}/cancel | Cancel; returns the penalty applied |
| PATCH | /v1/bookings/{ref}/guests | Guest details before the manifest cut-off |
| GET | /v1/events?after=<cursor> | Event feed for catch-up and resynchronisation |

**Contract enforcement:** every call is checked against the channel's contract: vessels, categories, rate plans, allocation model, visible-free cap, hold and option TTLs, stop-sell. A channel never sees another channel's allotments, holds or bookings.

**Idempotency and duplicates**

- Every write carries `Idempotency-Key`. The key is inserted first as `in_progress` under a unique constraint on (channel, key). A concurrent request with the same key gets `409 IN_PROGRESS` and retries. Same key, different body: `422`. Completed responses are replayed for 7 days.
- Bookings also carry the channel's own `channel_ref`, unique per channel forever. A create with an existing `channel_ref` returns the existing booking, so a retry after the key expires never duplicates.
- If the process crashes after commit but before responding, the retry with the same key returns the committed result.

**Events and webhooks**

- Events: `availability.changed`, `rate.changed`, `sailing.changed`, `hold.expired`, `booking.confirmed`, `booking.amended`, `booking.cancelled`, `request.decided`, `offer.created`, `payment.recorded`.
- Each event has a unique `event_id`, `type`, `resource`, `resource_id`, a monotonic `resource_version` and `occurred_at`. Payloads never contain passport numbers or dates of birth.
- Delivery is at least once, may be duplicated or out of order; channels ignore versions they have already seen. Signed with HMAC-SHA256, retried with backoff for 24 h.
- Failed deliveries are visible to the channel and the operator, with a replay button. `GET /v1/events` lets a channel catch up after downtime; `GET /v1/availability` is always the source of truth.

**Auth and limits:** OAuth 2.0 client credentials per channel; 600 requests/minute by default with `429` and `Retry-After`; a sandbox operator with a demo vessel; breaking changes only in a new version with 6 months' overlap.

**Later, on demand:** OpenTravel-style adapter for wholesalers and channel managers; Autoura connector.

## Agent portal

Most agents will never integrate an API, but they will log in. The agent portal gives a contracted agency live availability, options and documents across every vessel that has a contract with it, from one login. It ships in the first release after the pilot.

- **Access:** each agency is a channel; the operator creates the contract and invites the agency. An agency can have several users (owner, reservations, finance).
- **Search:** by date, nights, vessel, category; shows only contracted vessels, rate plans and prices (net or commissionable as contracted).
- **Book:** quote → option (hold with the contract's option TTL, e.g., 72 h) → confirm; or request where on request. Same engine path as the API.
- **Manage:** options expiring soon, amendments, cancellations with the penalty shown before confirming, guest details before the manifest cut-off.
- **Documents:** voucher, itinerary, embarkation instructions, invoices and statements.
- **Money:** credit balance, statements, payments due.
- **Isolation:** an agency sees only its own contracts, allotments, options and bookings, never another agency's.

Implementation: Next.js app in the vessel system, calling the same service layer as the channel API, with agency users authenticated separately from operator staff.

## Back office

The back office opens on what needs doing today. Arabic and English, right-to-left support, usable on a phone.

**Home: the daily action list**, sorted by urgency, each item one tap from its fix:

- Options and payment holds expiring today.
- Unanswered requests, with time left on the SLA.
- Deposits and balances overdue or due within 3 days.
- Missing guest details before the manifest cut-off.
- Departures in the next 7 days with unassigned cabins.
- Exceptions: paid but unavailable, schedule changes affecting bookings, emergency blocks over capacity, failed webhook deliveries, invariant violations.

**Fast manual booking (one screen):** sailing → category → cabins with adults and child ages → lead guest or agency → confirm. Availability and the total price update as fields change. Other guests' details can follow before the cut-off. Target: under 60 seconds for a phone booking.

**Controlled inventory changes (no free editing of counts):**

| Action | Effect | Rule |
| --- | --- | --- |
| Block cabins | Moves cabins from the pool to a `block` bucket on chosen legs, with a reason | Only free cabins |
| Emergency block | Same, for a cabin that must leave service now | May exceed free: creates an exception listing affected bookings and stops sales on those legs and categories until resolved |
| Release block | Returns cabins to the pool | — |
| Change capacity | Cabin added, removed or recategorised from a date | Cannot go below commitments; conflicts listed for staff to move first |
| Create, extend, reduce allotment | As in the transitions section | Only from free pool cabins; reduce only unused |

Every action records actor, reason and time, and appears in the inventory history.

**Schedule**

- Templates generate legs and sailings 18 months ahead.
- Exceptions: cancel a departure, shift a date, change ports (e.g., Esna lock or low water), dry-dock periods.
- Regeneration never deletes a leg with holds or bookings. Affected bookings are flagged on the action list, and channels receive `sailing.changed`.

**Bookings and requests:** search by reference, name, agency or date; amend, cancel, rebook; accept, decline or offer an alternative on requests with SLA countdown.

**Guests, assignment and manifests:** guest list per departure; auto-assign cabins at the cut-off with manual override; manifest and rooming list as PDF and Excel in the vessel's existing layout.

**Documents (bilingual PDF):**

- **Voucher:** booking reference, cruise and cabins, guests, inclusions and exclusions, embarkation port, time and boarding point, emergency contact.
- **Itinerary.**
- **Payment schedule and receipts.**
- **Cancellation terms** from the policy snapshot.

The agent version can omit prices.

**Also:** rates, seasons, child policies and supplements; channels and contracts; payments ledger; reports (occupancy per leg, pickup per week, production by channel, cancellations); weekly vacancy sheet export for agents not yet on the portal; users and roles (owner, reservations, finance, read-only) with MFA.

## Non-functional requirements

The system must never oversell, never leak one operator's data to another, and keep passport data only as long as needed.

**Tenant isolation**

- Row-Level Security on every tenant table, keyed on `operator_id`.
- The API, the agent portal and the worker connect as dedicated database roles that are **not** table owners and do **not** have `BYPASSRLS`. Each transaction sets the tenant (`SET LOCAL app.operator_id = …`) and policies read it.
- Supabase's `service_role` key bypasses RLS: it is used only for migrations and break-glass admin, never in request paths or the worker.
- Automated cross-tenant tests run under the real API and worker roles and try to read and write every table across operators.

**Sensitive data**

- Passport numbers are encrypted at field level and stored only in `guest`.
- They never appear in `audit_log` (the diff records only that the field changed), application logs, webhook payloads, event payloads or routine exports. Only the manifest export includes them.
- Passport numbers and dates of birth are erased 90 days after disembarkation (configurable per operator). Names stay for accounting.
- Compliance: Egypt's Personal Data Protection Law (Law 151 of 2020) and GDPR for EU guests: purpose records, export and deletion on request.

**Performance and freshness**

- Availability p95 under 300 ms for a 90-day search, served from Postgres with proper indexes. Add a cache only if measurements require it; any cache has a maximum staleness of 5 seconds. Holds and bookings always hit the database.
- Hold, confirm and amend p95 under 800 ms.

**Recovery**

- Recovery point: at most 5 minutes of data loss (point-in-time recovery). Recovery time: back in service within 4 hours. Restores tested quarterly.
- During an outage the API returns `503` with `Retry-After`, and channels show sailings as on request.
- Fallback for staff: a nightly PDF of the next 14 days' availability and manifests is emailed to the operator. Phone bookings taken during an outage are entered afterwards through the normal engine; conflicts land on the action list.

**Observability:** structured logs without personal data; traces on booking calls; alerts on invariant violations, hold-expiry backlog, allotment-release failures, webhook failure rate and payment exceptions.

**Stack:** Next.js + tRPC (back office and agent portal); a REST layer for the channel API from the OpenAPI spec; the vessel system's own Supabase Postgres project; one durable worker on a Postgres-backed queue (e.g., Graphile Worker or pg-boss) for expiries, releases, completions, outbox delivery and documents. No Redis until measurements justify it.

## MVP scope, releases and acceptance tests

The MVP is one vessel, run entirely from the back office, selling through nilecrz over the API. It must survive real booking changes before anything else is added. Start only after the current nilecrz batch (sheet ingest, one-tap requests) is live.

| Release | Contents | Gate to the next release |
| --- | --- | --- |
| MVP | Schedule → legs → sailings; buckets and invariants; holds, requests, offers, confirm, expiry, cancel; allotments; amendments; quotes with child and occupancy pricing and snapshots; manual payment recording; action list; fast booking; controlled adjustments; schedule exceptions; voucher and manifest; channel API v1 with contracts, idempotency and events; charters only if the pilot vessel sells them | One reservations manager runs the vessel for 30 days without a spreadsheet; 0 invariant violations; nilecrz books through the API with 0 oversells |
| Release 2 | Agent portal; agent credit and statements; payment gateway; second and third channels; full reports | 3 agencies using the portal weekly; a second vessel live |
| Later, on demand | Deck-plan assignment and guaranteed cabins; waitlist; OpenTravel adapter; Autoura connector; channel managers | A named partner or operator asking for it |

**Acceptance tests (automated, run in CI against the real database roles)**

1. **Parallel holds:** 5 free cabins on a leg; 200 simultaneous 1-cabin holds with no expiry or cancellation during the test → exactly 5 succeed.
2. **Overlap:** 1 free cabin on legs A and B; a 7-night (A + B) and a 4-night (A) hold sent simultaneously → exactly one succeeds.
3. **Confirm vs expiry:** 1,000 holds whose `expires_at` is now; confirm and the expiry job run concurrently on each → every hold ends confirmed or expired, never both, and counters match.
4. **Cancel vs allotment release:** run concurrently on the same allotment bucket → the cabin is counted once and ends in the pool.
5. **Duplicates:** the same `Idempotency-Key` sent 10 times concurrently → one booking. The same `channel_ref` after the key has expired → the existing booking is returned.
6. **Crash after commit:** the process is killed after commit and before the response; the retry with the same key returns the committed result.
7. **Failed amendment:** an amendment to a sold-out date leaves the booking, its revision and every counter unchanged.
8. **Late payment:** payment arrives after the hold expired and the cabin was sold → booking `paid_unavailable`, exception raised, no confirmation.
9. **Charter:** a charter cannot be accepted while any cabin on any of its legs is held or booked.
10. **Cross-tenant:** under the API and worker roles, operator A cannot read or write operator B's rows in any table.
11. **Redaction:** after a booking with passports is created, amended and cancelled, no passport number appears in `audit_log`, logs, events or webhook payloads.
12. **Invariants:** the reconciliation check passes after every test above.

## Open decisions

These are business answers the build needs. Defaults in brackets apply if no answer is given.

- **Pilot vessel:** which vessel, and which cruises it sells (3, 4, 7 nights; Luxor and Aswan starts; longer itineraries)?
- **Charters:** does the pilot vessel sell whole-boat charters? [No: charters move to Release 2]
- **Child and occupancy policy** of the pilot vessel: age bands, percentages, max children, triple cabins, single supplement.
- **Payment terms:** deposit % and balance due date for prepaid bookings [25%, 30 days before embarkation]; which agents get credit and their limits.
- **Holds:** checkout hold [30 min], agent option [72 h], offer [48 h], request SLA [6 h].
- **Cabin numbers:** assignment cut-off [7 days before embarkation]; are specific cabins ever guaranteed earlier? [No, until the later release]
- **Allotment release** default [21 days before embarkation].
- **Passport retention** after disembarkation [90 days].
- **Ownership:** does the vessel system sit in the same company as nilecrz or a separate one? This decides the terms and the neutrality message to operators and agencies.
