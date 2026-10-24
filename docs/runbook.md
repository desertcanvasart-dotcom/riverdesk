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

Hosted: prefix with `VS_ENV_FILE=.env.hosted`. The owner then signs in to the back office with that email (Supabase Auth verifies it); the first sign-in links them as the company's owner. The invitation is valid 14 days.

## Channel API docs

The contract is `packages/contracts/openapi.yaml`. The running API serves it at `/openapi.yaml` and as interactive docs at `/docs` (locally http://localhost:4000/docs). After editing the YAML, run `pnpm --filter @vs/contracts generate:api`.

## Roles

| Role            | Login | Used by                     | Notes                                                                            |
| --------------- | ----- | --------------------------- | -------------------------------------------------------------------------------- |
| `vs_owner`      | no    | migrations (via `SET ROLE`) | owns every table                                                                 |
| `vs_backoffice` | yes   | apps/backoffice             | RLS; may call `vs.resolve_staff`                                                 |
| `vs_api`        | yes   | apps/api                    | RLS                                                                              |
| `vs_worker`     | yes   | apps/worker                 | RLS; may call `vs.list_operator_ids`; only role with access to `graphile_worker` |

Rotate a runtime password: change it in the env file, then run `pnpm db:migrate`. Bootstrap sets the password on every run.

## Break-glass

To inspect every tenant, connect as `postgres` and run `set role vs_owner`. The owner bypasses RLS. Record what you did and why in the incident notes.
