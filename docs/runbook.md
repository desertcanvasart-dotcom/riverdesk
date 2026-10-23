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

Temporary progress view (local only, until Batch 6): http://localhost:3100/progress (`.claude/launch.json` runs the back office on 3100 and the API on 4000).

Demo logins (local Auth only): `owner@demo.local` and `reservations@demo.local`, password `SEED_STAFF_PASSWORD` from `.env`.

## Worker jobs

| Job                  | Schedule (UTC)   | Does                                                                          |
| -------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `expire_holds`       | every minute     | Expires holds past `expires_at` (database time), 500 per batch, `SKIP LOCKED` |
| `expire_requests`    | every 5 minutes  | Requests past SLA + grace → expired                                           |
| `release_allotments` | every 15 minutes | Releases allotment legs due by Cairo date                                     |
| `complete_bookings`  | hourly           | Confirmed bookings after their last night → completed                         |
| `nightly_invariants` | 00:00            | `check_invariants()` per operator; violations open exceptions and stop sales  |

## Look at availability

```bash
pnpm --filter @vs/engine availability-grid 4   # demo vessel, next 4 weeks, Markdown table
```

## Checks (same as CI)

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` runs packages one at a time against the local database. After every integration test file, `vs.check_invariants()` must return no rows, or the file fails.

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
