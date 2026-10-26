# Runbook

## Prerequisites

- Node 22.18 or later (`.nvmrc`), pnpm 10 (`corepack enable`), Docker Desktop running.
- Supabase CLI 2.111 or later.

## Run locally

```bash
pnpm install
cp .env.example .env          # local defaults; nothing secret
pnpm supabase:start           # local Postgres on 55322, Auth/API on 55321
pnpm db:migrate               # roles, schemas, migrations, Graphile Worker schema
pnpm db:seed                  # demo operator, two staff logins, demo vessel + 18 months of schedule
```

Then, each in its own terminal:

```bash
pnpm --filter @vs/backoffice dev   # http://localhost:3000
pnpm --filter @vs/api dev          # http://localhost:4000/health
pnpm --filter @vs/worker dev       # Graphile Worker + cron
```

Back office: http://localhost:3100 (`.claude/launch.json` runs the back office on 3100 and the API on 4000). Demo sign-in: `owner@demo.local` (TOTP from `SEED_TOTP_SECRET`), `reservations@demo.local`, `finance@demo.local` (TOTP), `viewer@demo.local`; password `demo-password-123`.

Demo logins (local Auth only): `owner@demo.local` and `reservations@demo.local`, password `SEED_STAFF_PASSWORD` from `.env`.

## Worker jobs

Start it with `pnpm --filter @vs/worker start` (or `dev` to restart on changes). It renders documents too, so the back office's PDF and Excel buttons need it running.

| Job                  | Schedule (UTC)   | Does                                                                          |
| -------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `expire_holds`       | every minute     | Expires holds past `expires_at` (database time), 500 per batch, `SKIP LOCKED` |
| `expire_requests`    | every 5 minutes  | Requests past SLA + grace → expired                                           |
| `release_allotments` | every 15 minutes | Releases allotment legs due by Cairo date                                     |
| `complete_bookings`  | hourly           | Confirmed bookings after their last night → completed                         |
| `overdue_balances`   | 05:00            | Overdue balance notices (and auto-cancel where the policy says so)            |
| `webhooks`           | every minute     | Fans events out to endpoints and delivers them (signed, in order, retried)    |
| `prune_rate_limits`  | hourly           | Drops rate-limit windows older than an hour                                   |
| `nightly_invariants` | 00:00            | `check_invariants()` per operator; violations open exceptions and stop sales  |
| `assign_cabins`      | 01:00            | Departures inside the assignment cut-off get physical cabins                  |
| `erase_passports`    | 01:30            | Passport numbers and dates of birth erased after the retention period         |
| `prune_documents`    | hourly           | Deletes expired documents (manifests after a day, others after a week)        |
| `health_alerts`      | every 5 minutes  | Checks the alert conditions below per company; logs and tracks each one       |
| `render_document`    | on request       | Renders a requested PDF, Excel or PNG (queued by `vs.enqueue_document`)       |

## Observability

- **Logs**: structured JSON (pino) on stdout from the API, worker and back office. Sensitive keys (passport numbers, secrets, tokens, authorization headers) are redacted before writing.
- **Error tracking**: set `SENTRY_DSN` (one project per environment) on the API, worker and back office. Unset, errors are only logged. The scrubber drops user data, cookies, headers, query strings and request bodies, and deep-redacts extra data (`packages/shared/src/tracking.ts`, tested).
- **Alerts**: the `health_alerts` job sends a Sentry warning `alert:<name>` per condition and company, and logs it at error level with `"alert": "<name>"`. In Sentry, create one alert rule: _a new or regressed issue whose message starts with `alert:`_, notifying the operations email or WhatsApp group.

| Alert                      | Fires when                                                                         | First response                                                        |
| -------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `invariant_violations`     | An invariant exception is open (the nightly check found one)                       | Today screen → the exception; sales are already stopped on that leg   |
| `hold_expiry_backlog`      | Active holds more than 5 minutes past expiry                                       | Is the worker running? Check its logs; `expire_holds` catches up      |
| `allotment_release_failed` | Unreleased allotment cabins past their release date (1 day grace), or an exception | Check worker logs for `release_allotments`; release by hand if needed |
| `webhook_failure_rate`     | Over 10% of the last hour's webhook attempts failed (at least 10 attempts)         | Channels → the endpoint's delivery log; contact the channel           |
| `payment_exceptions`       | A late payment or paid-but-unavailable exception opened in the last 5 minutes      | Today screen → the booking                                            |

## Documents

Rendered by the worker with headless Chromium (Playwright) and ExcelJS; fonts (Noto Sans, Noto Sans Arabic) are embedded, so output is the same on any server. Install Chromium once where the worker runs:

```bash
pnpm --filter @vs/worker exec playwright install chromium
```

To check layouts by eye, render one demo booking's documents (both languages, full and agency copy) to a folder:

```bash
pnpm --filter @vs/worker render-sample VS-26-00001 /tmp/vs-docs
```

## Look at availability

```bash
pnpm --filter @vs/engine availability-grid 4   # demo vessel, next 4 weeks, Markdown table
```

## Checks (same as CI)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` runs packages one at a time against the local database. After every integration test file, `vs.check_invariants()` must return no rows for the operators that file created, or the file fails.

Stop a locally running worker before `pnpm test`: it shares the job queue with the worker tests and would take their jobs.

## Migrations

- Plain SQL in `packages/db/migrations/NNNN_name.sql`. Each file runs once, in order, in one transaction, as `vs_owner`.
- An applied file must never change; the runner fails on a checksum mismatch. Fix forward with a new file.
- New tables in schema `vs` automatically get DML grants for the runtime roles (default privileges). Every new tenant table needs `operator_id`, RLS enabled, the `tenant_isolation` policy, and a fixture in `packages/db/src/testing/fixtures.ts`. The cross-tenant test fails until all of these exist.
- After changing the schema: `pnpm db:codegen` regenerates `packages/db/src/generated/types.ts`. CI fails if the committed file is stale.

## Reset the local database

```bash
pnpm db:reset    # drops everything owned by vs_owner, then migrates and seeds (incl. demo vessel)
```

`reset` and `seed` refuse to run against a non-local host.

## Deploying (Railway)

The four services run on Railway. Setup, variables per service, domains and checks are in [`docs/deploy-railway.md`](deploy-railway.md). Every push to `main` redeploys; **Deployments → Rollback** in Railway returns to a previous version.

## Hosted Supabase

- Real values live in `.env.hosted` (git-ignored, mode 600). Use it with `VS_ENV_FILE=.env.hosted`. The file holds no `service_role` key, and none is needed.
- Migrate: `VS_ENV_FILE=.env.hosted pnpm db:migrate`. This connects through the Session pooler as `postgres`.
- Check runtime logins: `VS_ENV_FILE=.env.hosted pnpm db:check-roles` (read-only; prints no secrets).
- Runtime roles connect through the Supavisor pooler as `<role>.<project ref>`. Back office and API use the transaction port (6543); the worker uses the session port (5432).

## Add a cruise company

```bash
pnpm platform:create-company --name "Nile Dream Cruises" --slug nile-dream --prefix NDM \
  --owner-email owner@niledream.com --owner-name "Mona Hassan" --locale ar
```

Hosted: prefix with `VS_ENV_FILE=.env.hosted`. The owner then opens the back office's sign-in page, chooses **First time here? Create your password** with that email, and opens the confirmation link (Supabase Auth verifies the email); that first sign-in links them as the company's owner. The invitation is valid 14 days.

The same can be done in the browser from the **platform area** (below), which is the usual way.

## Platform area (`/platform`)

The platform owner's screen in the back office: every company with counts only (staff, ships, bookings; never bookings or guests themselves), **Add a company** (same as the command above) and **Invite an owner again** for a company whose owner never signed in. It needs a password and the two-step code, always.

Let an email in (it must also have a Riverdesk login, created at `/signup` or through an invitation):

```bash
VS_ENV_FILE=.env.hosted pnpm platform:add-admin --email you@example.com
VS_ENV_FILE=.env.hosted pnpm platform:add-admin --email you@example.com --remove
```

A platform admin with no company login lands on `/platform` after sign-in; one who is also a company's staff sees a **Platform** link at the bottom of the menu. Platform actions are logged in `platform.action_log`.

## Passwords and email links

- **Create your password** (`/signup`): invited people choose a password; Supabase emails a confirmation link. **Forgot your password?** (`/forgot-password`) emails a reset link. Both links land on `/auth/callback`, which signs the person in and continues. Links must be opened in the same browser (PKCE).
- Someone with a two-step code is asked for it before choosing a new password (Supabase requires it).
- Hosted Supabase: **Authentication → URL Configuration**: Site URL `https://app.riverdsk.com`, Redirect URLs `https://app.riverdsk.com/**`. **Authentication → Sign In / Providers → Email**: keep **Confirm email** on.
- Supabase's built-in mailer sends only a few emails an hour and is meant for testing. Before more companies join, set custom SMTP under **Authentication → Emails → SMTP Settings**.
- Locally the emails land in Mailpit: http://127.0.0.1:55324.

## Channel API docs

The contract is `packages/contracts/openapi.yaml`. The running API serves it at `/openapi.yaml` and as interactive docs at `/docs` (locally http://localhost:4000/docs). After editing the YAML, run `pnpm --filter @vs/contracts generate:api`.

## Roles

| Role            | Login | Used by                     | Notes                                                                            |
| --------------- | ----- | --------------------------- | -------------------------------------------------------------------------------- |
| `vs_owner`      | no    | migrations (via `SET ROLE`) | owns every table                                                                 |
| `vs_backoffice` | yes   | apps/backoffice             | RLS; may call `vs.resolve_staff`                                                 |
| `vs_api`        | yes   | apps/api                    | RLS                                                                              |
| `vs_worker`     | yes   | apps/worker                 | RLS; may call `vs.list_operator_ids`; only role with access to `graphile_worker` |
| `vs_website`    | yes   | apps/website                | no table rights; may only call `vs.submit_pilot_request`                         |

Rotate a runtime password: change it in the env file, then run `pnpm db:migrate`. Bootstrap sets the password on every run.

## Break-glass

To inspect every tenant, connect as `postgres` and run `set role vs_owner`. The owner bypasses RLS. Record what you did and why in the incident notes.

## Backups and restore

**What Supabase keeps (checked 2026-10-24 with `supabase backups list --project-ref nwbjuamzkguqmcxsxkkl`):** daily physical backups (WAL-G). **Point-in-time recovery is enabled** (7 days; turned on and verified 2026-10-24: `"pitr_enabled": true`, restorable from 2026-10-23 17:29 UTC, and all four role logins `ok` afterwards). Re-run the command whenever backups are checked.

**Restore from a Supabase backup (the real path):** Dashboard → Database → Backups → pick a backup (or a point in time once PITR is on) → Restore. The restore replaces the project's database, including `auth` (staff logins), `vs` and `graphile_worker`. Afterwards:

1. `VS_ENV_FILE=.env.hosted pnpm db:check-roles`: all four logins must say `ok`.
2. `VS_ENV_FILE=.env.hosted pnpm db:migrate`: it applies nothing, or the migrations newer than the backup.
3. Pilot dashboard: invariants hold, no oversells.
4. Restart the worker. Holds that expired during the outage are expired on its first run.

**Logical restore drill (done 2026-10-24).** It proves the dump of the application schemas restores cleanly with ownership, grants, RLS and data intact, and it times it:

```bash
# dump (admin connection; never print it)
pg_dump -Fc -n vs -n vs_migrations -f vs.dump "$DATABASE_URL_ADMIN"
# restore into an empty database that has btree_gist in schema extensions
createdb restore_drill
psql -d restore_drill -c "create schema extensions; create extension btree_gist with schema extensions; grant create on database restore_drill to vs_owner;"
pg_restore -d restore_drill --role=vs_owner --no-owner -j 4 --exit-on-error vs.dump
```

| Source                                                     | Dump | Size   | Restore | Check                                                                                            |
| ---------------------------------------------------------- | ---- | ------ | ------- | ------------------------------------------------------------------------------------------------ |
| Hosted (eu-west-1, schema only: no companies yet)          | 13 s | 0.3 MB | 1 s     | 8 migrations present                                                                             |
| Local, 1,034 companies, 6,551 bookings, 116,768 audit rows | 9 s  | 41 MB  | 11 s    | Row counts, 56 RLS policies, grants and the invariant check identical between source and restore |

A restore into a separate scratch Supabase project (spec wording) needs a second project on the account. Repeat this drill against it once one exists, and record the timings here.

## Go-live checklist

Tick each line, with a date and initials, before the pilot vessel takes its first real booking.

- [ ] **Secrets rotated** since development: database passwords (`vs_backoffice`, `vs_api`, `vs_worker`, admin), `API_TOKEN_SECRET`, `FIELD_KEYS` (new key current, old key kept for decryption), the nilecrz client secret (rotate: add the second secret, switch, revoke the old one), webhook signing secrets.
- [ ] **No development values on production:** `SEED_TOTP_SECRET` unset, demo users absent, `VS_ENV=hosted`.
- [ ] **MFA on:** every owner and finance user has enrolled TOTP (they cannot work without it), and reservations users are encouraged to.
- [ ] **Roles reviewed** on Settings: one or two owners, no shared logins, read-only for anyone who only looks. Remove leavers.
- [x] **Backups verified (PITR):** enabled and shown by `supabase backups list`, 2026-10-24.
- [ ] **Restore drill:** repeated into a scratch Supabase project within the last 30 days.
- [ ] **Monitoring live:** `SENTRY_DSN` set on the API, worker and back office. The `alert:` rule notifies the operations inbox. A test alert was received.
- [ ] **Outage pack arriving:** `SMTP_URL` and `MAIL_FROM` set, Settings → operations email filled in, and the first 02:00 UTC pack received and opened.
- [ ] **Worker running** with Chromium installed (`playwright install chromium`). A voucher downloads in Arabic and English.
- [ ] **nilecrz sandbox flow passed against production configuration:** token, availability, quote, hold, confirm, guests, amend, cancel, events and a signed webhook, all on the sandbox company with production settings (API URL, rate limits, TLS).
- [ ] **Pilot import done:** `--dry-run` reviewed with the reservations manager, the real run's report kept, and conflicts resolved by hand.
- [ ] **Staff trained on the action list:** each reservations user has taken a phone booking, answered a request, recorded a payment and printed a voucher. They know Today is the first screen each morning.
- [ ] **Pilot dashboard green:** invariants hold, 0 oversells.

## Public website (`apps/website`)

The public homepage and docs: Home, Features, For agencies & channels, Security, Data Charter, the Founding Operator Program form (`/pilot`), and Docs. Arabic (`/ar`, the default) and English (`/en`). It has no login, and every page is rendered to static HTML at build time. Its only server code is `POST /api/pilot`, which stores a request in `platform.pilot_request` through the `vs_website` role and emails it to `PILOT_NOTIFY_EMAIL`. Read requests as `vs_owner`: `select * from platform.pilot_request order by created_at desc`.

```bash
pnpm --filter @vs/website dev        # http://localhost:3200
```

| Setting                                      | What it does                                                             | Default                      |
| -------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
| `NEXT_PUBLIC_APP_URL`                        | "Sign in" goes here (the back office)                                    | `http://localhost:3100`      |
| `NEXT_PUBLIC_API_DOCS_URL`                   | "Live API reference"                                                     | `http://localhost:4000/docs` |
| `NEXT_PUBLIC_SITE_URL`                       | canonical links, hreflang and Open Graph                                 | `http://localhost:3200`      |
| `NEXT_PUBLIC_WHATSAPP_NUMBER`                | the floating WhatsApp button and the form's next step; hidden when unset | unset                        |
| `NEXT_PUBLIC_FOUNDING_SEATS`                 | "Limited to N founding vessels"                                          | `20`                         |
| `NEXT_PUBLIC_DEMO_VIDEO_URL_AR` / `_EN`      | "See it in 90 seconds" plays it; hidden when unset                       | unset                        |
| `NEXT_PUBLIC_DEMO_VIDEO_CAPTIONS_AR` / `_EN` | `.vtt` captions for the video                                            | unset                        |
| `PILOT_NOTIFY_EMAIL`                         | where new pilot requests are emailed (with `SMTP_URL`)                   | unset                        |

- **Docs** are Markdown files in `apps/website/content/docs/<ar|en>/<section>/NN-slug.md`, with a `title` and `summary` in the front matter. English defines the pages and their order. An Arabic page that is missing falls back to English, with a notice. Links are written without the language (`/docs/staff-guide/today`) and keep the reader's.
- **Screenshots** in `public/screens/<locale>/` come from the demo company. Refresh them after screen changes, with the back office running: `pnpm --filter @vs/backoffice website-shots`.
- **Test**: `pnpm --filter @vs/website test` checks that every page has a title and summary, every internal link and screenshot exists, and every Arabic page has an Arabic title.
