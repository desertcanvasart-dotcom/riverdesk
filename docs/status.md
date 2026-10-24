# Where we stopped (2026-10-24)

This page is written to be read by you, not by a machine. It says what exists, where it is, what is waiting on you, and what the words mean.

## In one paragraph

The vessel-system MVP is built. All the planned batches (Part 0, then Batches 0 to 7) are finished, tested, and pushed to GitHub, and the automatic checks (CI) pass. The database on Supabase (the "hosted" one) has every change applied, up to migration 0009. What is left is not programming. It is setting up accounts and services that only you can create, then going through the go-live checklist. Point-in-time recovery is now enabled and verified (2026-10-24). The next step is choosing hosting.

## Exactly where we stopped

You were about to enable point-in-time recovery (PITR) in the Supabase dashboard. When you come back:

1. Tell me whether it is enabled. If it is, say "done".
2. I will then run two checks:
   - `supabase backups list --project-ref nwbjuamzkguqmcxsxkkl` must show `"pitr_enabled": true`;
   - `VS_ENV_FILE=.env.hosted pnpm db:check-roles` must show four `ok` lines.
3. I will tick the "Backups verified" line in the go-live checklist (`docs/runbook.md`). The other half of that line (a restore drill into a scratch project) stays open.

**What PITR is:** Supabase already keeps one full backup of the database per day. With PITR it also records every change, so after an accident you can restore the database to any minute of the last 7 days, not just to last night's copy. It is a paid add-on and may require a bigger compute size. On the dashboard: Database → Backups → Point in Time.

## What waits on you (accounts and decisions)

| #   | Item                                                    | Why it matters                                                                                        | My recommendation                                                                                                                           |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | ~~Enable PITR~~ **done 2026-10-24**                     | Lets us undo a disaster to the minute, not to last night                                              | 7 days of retention                                                                                                                         |
| 2   | **Sentry account** (error tracking)                     | When something breaks on the live system, we see it at once, with personal data removed               | One Sentry project per environment. Put the key (`SENTRY_DSN`) in `.env.hosted` yourself, never in chat                                     |
| 3   | **An email (SMTP) account**                             | The nightly "outage pack" PDF is emailed to the office, so staff can still work if the system is down | Use your mail provider's SMTP. Set `SMTP_URL` and `MAIL_FROM` in `.env.hosted`, and the operations email on the Settings screen             |
| 4   | **A scratch Supabase project**                          | To rehearse a full restore into a fresh project, as the spec asks                                     | Create it near go-live, run the drill, then delete it                                                                                       |
| 5   | **Hosting** for the API, the worker and the back office | Today they only run on your Mac. They need a server to run for real                                   | Decide this next. The worker needs a machine that can run Chromium, the built-in browser used to make PDFs                                  |
| 6   | **The hosted sandbox for nilecrz**                      | A separate test company on the real system, so nilecrz can test their integration                     | Create it when nilecrz is ready (you asked me to wait). The command is ready: `VS_ENV_FILE=.env.hosted pnpm sandbox:setup --confirm-hosted` |

After those comes the **go-live checklist** at the end of `docs/runbook.md`: rotate secrets, MFA, roles, backups, monitoring, outage pack, worker, nilecrz test, pilot import, staff training, pilot dashboard.

## What exists, part by part

The code lives in one repository (`github.com/desertcanvasart-dotcom/riverdesk`), split into parts:

| Part            | Folder               | What it is                                                                                                                                                                                                          | Who uses it                   |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Engine**      | `packages/engine`    | The brain: every rule (availability, prices, holds, bookings, payments, cancellations, documents). Nothing writes to the database except through it.                                                                | Everything below              |
| **Database**    | `packages/db`        | The tables (made by "migrations" 0001–0009), the security roles, and test helpers                                                                                                                                   | The engine                    |
| **Back office** | `apps/backoffice`    | The website staff use: Today, New booking, Bookings, Requests, Inventory, Schedule, Rates, Channels, Payments, Guests & manifests, Vacancy sheet, Settings, Pilot. Arabic and English, works on a phone.            | Your reservations staff       |
| **Channel API** | `apps/api`           | The door for nilecrz and other agencies' systems to check availability and book automatically. Documented at `/docs`.                                                                                               | nilecrz's developers          |
| **Worker**      | `apps/worker`        | A program that runs in the background, all the time: expires holds, releases allotments, sends webhooks to channels, makes PDFs, assigns cabins, erases old passports, sends alerts, emails the nightly outage pack | Nobody directly. It just runs |
| **Contracts**   | `packages/contracts` | The exact description of the Channel API (`openapi.yaml`) that you approved                                                                                                                                         | nilecrz, and our tests        |
| **Shared**      | `packages/shared`    | Small common tools: settings, logging, money, encryption, error tracking                                                                                                                                            | All parts                     |

## Where to read more

- `docs/spec-v2.md`: the specification. It is the source of truth.
- `docs/decisions.md`: every choice made along the way, with the reason. Read this when you wonder why something works the way it does.
- `docs/backlog.md`: ideas deliberately left for after the MVP.
- `docs/runbook.md`: how to run, check, back up, restore and go live. It also has the alert table and the go-live checklist.
- `docs/performance.md`: the speed measurements. All targets are met by a wide margin.
- `docs/integration-nilecrz.md`: the guide for nilecrz's developers.
- `docs/pilot/import-template.csv`: the template for importing the pilot vessel's existing bookings.

## The public website

The homepage and docs run at http://localhost:3200 (Arabic at `/ar`, English at `/en`) with `pnpm --filter @vs/website dev`. It is a separate site with no login and no database, so it can be put online on its own. Choosing hosting and a domain for it is part of item 5 above.

## How to look at it on your Mac

1. Docker must be running, then `pnpm supabase:start` starts the local database.
2. Open the back office: run it from the Claude app, or with `pnpm --filter @vs/backoffice exec next dev --port 3100`. It is at http://localhost:3100.
3. Sign in as `owner@demo.local` with password `demo-password-123`. Owners also need a 6-digit code from an authenticator app set up with the demo secret. Simpler: `reservations@demo.local` or `viewer@demo.local`, same password, which need no code.
4. To make PDFs locally, the worker must run: `pnpm --filter @vs/worker start`. Stop it before running tests: it would take the tests' jobs.

## Words you will see

- **Batch**: a chunk of work, ended by a report. All of them (Part 0 and Batches 0–7) are done.
- **Migration**: a numbered file that changes the database's structure. There are 0001 to 0009, all applied to hosted.
- **Hosted vs local**: hosted is the real Supabase project in the cloud (Ireland, eu-west-1); local is the copy on your Mac. Hosted passwords are in `.env.hosted`, which never leaves your machine and is never printed.
- **CI**: GitHub runs all checks and tests on every push. Green means everything passed.
- **RLS (row-level security)**: the database itself stops one cruise company from ever seeing another's data.
- **Invariant**: a rule that must always be true, for example "never more cabins booked than exist". It is checked after every test and every night. A violation stops sales on that departure and appears on Today.
- **Hold / option**: cabins reserved for a short time before confirmation. Holds expire automatically.
- **Allotment**: cabins set aside for one agency, returned to general sale a set number of days before departure.
- **Webhook**: a message our system sends to nilecrz when something changes, such as a booking confirmed or a date moved.
- **Manifest**: the passenger list for a departure. It is the only export that contains passport numbers, kept for one day, and only owners and reservations can download it.
- **Outage pack**: the nightly PDF of the next 14 days (availability and who is aboard), so the office can keep working if the system is down.
- **Sentry**: an online service that collects errors from a running system, so we know about problems before guests or staff report them.
- **SMTP**: the standard way a program sends email through a mail account.
- **PITR**: point-in-time recovery, explained above.
- **Sandbox**: a pretend company on the real system, for nilecrz to test against without touching real bookings.

## Numbers at the stop

- 259 automated tests, all passing; CI green on the final commit.
- Performance, with 21 vessels and 18 months of schedule (targets in brackets):

| Measure                    | p95 (95% of requests faster than this) | Target       |
| -------------------------- | -------------------------------------- | ------------ |
| 90-day availability search | 27–116 ms                              | under 300 ms |
| Hold                       | 69 ms                                  | under 800 ms |
| Confirm                    | 131 ms                                 | under 800 ms |
| Amend                      | 226 ms                                 | under 800 ms |

- Simulated phone booking at human pace: 9.6 seconds and 6 taps (target: under 60 s).
- Restore drill: 41 MB of test data dumped in 9 s and restored in 11 s, identical afterwards.
