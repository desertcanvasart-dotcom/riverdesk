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
- Apply the migrations to the hosted Supabase project and confirm the runtime roles log in through Supavisor as `role.projectref`.
- `pnpm db:check-hosted`: a read-only command that runs the role and RLS structure checks against the hosted database.
