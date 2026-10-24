# Performance (Batch 7)

Run with `pnpm --filter @vs/engine perf` (local database only). The script creates a fresh company with the pilot vessel and 20 synthetic vessels, each with 18 months of schedule from today. That is 3,276 legs, 6,531 sailings and 13,104 inventory buckets, seeded in 12 s. It books 300 background cabins on the pilot vessel, then measures:

- **Availability for a 90-day search**: 100 searches at random start dates within the 18 months, half on the pilot vessel. Both the staff view (`getAvailability`) and the channel view (`channelAvailability`, which the API serves) are timed.
- **Hold, confirm and amend under 20 concurrent clients**: 10 rounds each. Each round quotes, then holds (timed), then confirms (timed). The amendment to another sailing is timed as quote plus apply. Half the traffic hits the pilot vessel, so clients contend for the same buckets. All of it runs as `vs_api` through `withTenantTx`, with locks and retries as in production.

## Result (2026-10-24, local: Apple silicon, Supabase CLI Postgres in Docker)

| Operation                       |   n | p50 ms | p95 ms | max ms | Target p95 |
| ------------------------------- | --: | -----: | -----: | -----: | ---------: |
| Availability 90 days (staff)    | 100 |     12 |     27 |     62 |    < 300 ✓ |
| Availability 90 days (channel)  | 100 |     44 |    116 |  2,154 |    < 300 ✓ |
| Hold (20 concurrent clients)    | 197 |     41 |     69 |    126 |    < 800 ✓ |
| Confirm (20 concurrent clients) | 197 |     82 |    131 |    174 |    < 800 ✓ |
| Amend (20 concurrent clients)   | 191 |    172 |    226 |    275 |    < 800 ✓ |

- Under contention, 9 operations were refused with `NOT_AVAILABLE` (cabins sold out on contested sailings). That is correct behaviour, not an error.
- The one 2.2 s channel-availability call was the first search after seeding (cold plans and cache). Every later search stayed under 250 ms.
- No index or cache was added: the numbers do not require one.
- Hosted latency adds the network round trip to eu-west-1 per transaction. Repeat the run against a scratch hosted project before go-live; the script refuses `VS_ENV=hosted` on purpose, so point a local `.env` at the scratch project.
