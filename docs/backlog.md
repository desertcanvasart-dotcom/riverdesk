# Backlog

Ideas and later work. Nothing here is built until a batch or a named demand asks for it.

## Out of MVP scope (prompt § Out of scope)

- Agent portal (Release 2).
- Payment gateway adapters (Egyptian gateway for EGP and local cards; international acquirer).
- Agent statements UI.
- Deck-plan assignment and guaranteed cabins.
- Waitlist.
- OpenTravel or channel-manager adapters.
- Autoura connector.
- Charters: whole-boat bookings, `charter_rate`, spec test 9. The pilot vessel doesn't sell charters.
- Multi-vessel dashboards.
- Any change to nilecrz itself.

## Noted during Batch 0

- Bundle `apps/api` and `apps/worker` for deployment (they currently run TypeScript through tsx). Do this with the hosting choice, before Batch 7.
- Run the full role and definer allow-list checks (`checkRolesAndDefiners`) against the hosted database, not only `pnpm db:check-roles`.

## Noted during Batch 1

- Event feed (Batch 5): order by `seq` but never serve events newer than the oldest in-flight transaction. The `txid` column is already stored for this.
- The emergency-block exception lists commitment counts per leg; list the affected bookings once bookings exist (Batch 3).
- Shifting a sailing onto the date of another sailing of the same pattern collides with `sailing_pattern_date_idx`. Rare; handle it if it ever happens.
- Auto-resolve `schedule_change` exceptions once their bookings have been amended or cancelled (Batch 3/6).
- Allotment buckets: add the foreign key from `inventory_bucket.allotment_id` with the allotment table (Batch 3).

## Noted during Batch 2

- Optional supplements chosen at quote time (spec mentions `mandatory`; the MVP prices mandatory ones only).
- Pricing by the lead guest's nationality and residency (spec § Market). The MVP takes the market as a quote input; staff reprice if the guest cannot show ID.
- Child band amounts in another currency than the rate plan are refused; add per-currency fixed child amounts if a plan ever needs them.
- Extra-bed pricing (`extra_bed_allowed` on categories is stored but not priced).

## Noted during Batch 3

- Credit limit check at confirmation (Batch 4): a credit booking over the limit becomes a request.
- Emergency-block exceptions: list the affected bookings, not only the counts.
- A quote can back several holds; make quotes single-use per hold if channels misuse them.
- Charters (spec test 9) remain out of the MVP.

- Back office: editors for schedule templates, itineraries (sailing patterns), seasons and cancellation, child and payment policies. MVP shows them read-only; the setup script creates them. Batch 8 builds them step by step (steps 1–5, ships and cabins, ports, routes and itineraries, seasons and policies, rate plans and the getting-started checklist, cabin map: done 2026-10-24).
- Channels: edit an existing contract's categories and plans on the Channels screen (today: at creation, plus the plan editor's "Sold through"). (Markets and more currencies: done 2026-10-24.)
- Batch 8 step 5, the staff cabin map, done 2026-10-24. Later options, not agreed: deck-plan drawings with cabins placed on them; guests or agents choosing exact cabins (guaranteed cabins, see Out of MVP scope); dragging tiles instead of two clicks.
- Routes: board-only or leave-only stops in the editor (today one tick sets both); itineraries spanning more than one extra cycle (the engine allows up to 8).
- Ships: take a ship out of service (deactivate) once it has no future departures; delete a category that was never used.
- Website: a contact or demo-request form (today a mailto link), a custom domain and hosting, privacy-friendly analytics if wanted, and docs search.
- Guest check-in details by CSV import (Batch D2 kept the pilot import to names; details come from the booking screen and the Channel API).
- Check-in file columns to match the vessels' real police list (waiting for a sample from the owner).
