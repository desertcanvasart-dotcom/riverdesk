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

- Back office: editors for schedule templates, itineraries (sailing patterns), seasons and cancellation, child and payment policies. MVP shows them read-only; the setup script creates them.
