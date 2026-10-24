# Putting Riverdesk online with Railway

This guide is for you, step by step. Riverdesk runs as **four services** in one Railway project, all built from the GitHub repository. The database stays on Supabase: Railway runs only the programs.

| Service      | What it is                                      | Public address               | Recipe                         |
| ------------ | ----------------------------------------------- | ---------------------------- | ------------------------------ |
| `website`    | The public homepage and docs                    | yes, e.g. `riverdsk.com`     | `deploy/website.Dockerfile`    |
| `backoffice` | The staff app                                   | yes, e.g. `app.riverdsk.com` | `deploy/backoffice.Dockerfile` |
| `api`        | The Channel API for nilecrz and other platforms | yes, e.g. `api.riverdsk.com` | `deploy/api.Dockerfile`        |
| `worker`     | Background jobs and PDFs                        | no                           | `deploy/worker.Dockerfile`     |

Until the domain is ready, Railway gives each public service a free address like `backoffice-production-1234.up.railway.app`.

> **Never paste a password or key into a chat.** Every secret goes straight into Railway's **Variables** screen. The values are in `.env.hosted` on your Mac: open it in a text editor and copy from there.

## 1. Create the account and the project (you)

1. Sign up at **railway.com** with your email or GitHub. Choose the **Hobby** plan (about USD 5 a month, including usage credit. Four small services usually cost USD 10–25 a month in total; Railway shows usage live).
2. **New Project → Deploy from GitHub repo**. Allow Railway to see the repository `desertcanvasart-dotcom/riverdesk` (the GitHub owner must approve the access).
3. Railway creates one service from the repository. Rename it `website` (service → Settings → Name).
4. Create the other three: **+ New → GitHub Repo → riverdesk**, three times. Name them `backoffice`, `api` and `worker`.
5. Set the project's region to **Europe West** (each service → Settings → Region), close to the database in Ireland.

## 2. Point each service to its recipe

For each service, open **Settings** and set **Config-as-code → Railway config file** to:

| Service      | Config file path                 |
| ------------ | -------------------------------- |
| `website`    | `deploy/railway.website.json`    |
| `backoffice` | `deploy/railway.backoffice.json` |
| `api`        | `deploy/railway.api.json`        |
| `worker`     | `deploy/railway.worker.json`     |

Leave **Root directory** empty (the whole repository is needed).

## 3. Variables (settings) for each service

Open each service → **Variables → Raw editor**, and paste the names below with their values. Values marked **from `.env.hosted`** are copied from that file on your Mac. Never send them to anyone.

### All three of `backoffice`, `api`, `worker`

| Name                   | Value                                |
| ---------------------- | ------------------------------------ |
| `VS_ENV`               | `hosted`                             |
| `LOG_LEVEL`            | `info`                               |
| `DATABASE_HOST`        | from `.env.hosted`                   |
| `DATABASE_PORT`        | from `.env.hosted` (6543)            |
| `DATABASE_NAME`        | from `.env.hosted`                   |
| `DATABASE_SSL`         | from `.env.hosted`                   |
| `SUPABASE_PROJECT_REF` | from `.env.hosted`                   |
| `PASSPORT_KEY_ID`      | from `.env.hosted`                   |
| `PASSPORT_KEY`         | from `.env.hosted`                   |
| `SENTRY_DSN`           | later, once Sentry exists (optional) |

### Only on `backoffice`

| Name                       | Value              |
| -------------------------- | ------------------ |
| `VS_BACKOFFICE_PASSWORD`   | from `.env.hosted` |
| `SUPABASE_URL`             | from `.env.hosted` |
| `SUPABASE_PUBLISHABLE_KEY` | from `.env.hosted` |

### Only on `api`

| Name               | Value              |
| ------------------ | ------------------ |
| `VS_API_PASSWORD`  | from `.env.hosted` |
| `API_TOKEN_SECRET` | from `.env.hosted` |

### Only on `worker`

| Name                    | Value                                          |
| ----------------------- | ---------------------------------------------- |
| `VS_WORKER_PASSWORD`    | from `.env.hosted`                             |
| `DATABASE_SESSION_PORT` | from `.env.hosted` (5432)                      |
| `SMTP_URL`, `MAIL_FROM` | later, once the mail account exists (optional) |

### Only on `website` (nothing secret)

| Name                        | Value                                                                       |
| --------------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`       | the back office's public address, e.g. `https://app.riverdsk.com`           |
| `NEXT_PUBLIC_API_DOCS_URL`  | the API's address followed by `/docs`, e.g. `https://api.riverdsk.com/docs` |
| `NEXT_PUBLIC_CONTACT_EMAIL` | the demo-request address (optional)                                         |

The website bakes these into its pages, so after changing one, **redeploy** the website.

**Do not** add `DATABASE_URL_ADMIN`, `SEED_STAFF_PASSWORD` or `SEED_TOTP_SECRET` to any service. They are for setup from your Mac only.

## 4. Public addresses

For `website`, `backoffice` and `api`: **Settings → Networking → Generate Domain**. Railway gives each one a `….up.railway.app` address. The `worker` gets none.

Then set the website's two `NEXT_PUBLIC_…` variables to the back office and API addresses, and redeploy the website.

## 5. Tell Supabase where the back office lives

In the Supabase dashboard: **Authentication → URL Configuration**:

- **Site URL**: the back office address (`https://….up.railway.app`, later `https://app.riverdsk.com`).
- **Redirect URLs**: add the same address followed by `/**`.

## 6. Deploy and check

Railway builds and deploys each service when its settings are saved, and again on every push to `main`. The first build takes 5–10 minutes. Then:

- the **website** address shows the homepage;
- **backoffice** `…/api/health` shows `{"status":"ok","database":true}`;
- **api** `…/health` shows `{"status":"ok","database":true}`, and `…/docs` shows the API reference;
- **worker** → Deployments → Logs shows `worker started`.

Tell me when you reach this point and I will run the full checks with you.

## 7. Your domain: riverdsk.com

| Address                                 | Service      |
| --------------------------------------- | ------------ |
| `riverdsk.com` (and `www.riverdsk.com`) | `website`    |
| `app.riverdsk.com`                      | `backoffice` |
| `api.riverdsk.com`                      | `api`        |

### Steps

For each public service: **Settings → Networking → Custom Domain**. Enter for example `riverdsk.com` (website), `app.riverdsk.com` (back office) and `api.riverdsk.com` (API). Railway shows a **CNAME** record for each. Add those records at your domain registrar. Within minutes to a few hours, HTTPS works on your domain. Then update the website variables, the Supabase Site URL, and the Redirect URLs to the new addresses.

## Costs and limits to know

- Each service uses memory only while running. The worker runs all the time (holds must expire on time).
- The worker's image is the largest (it includes the PDF engine, Chromium).
- Railway keeps the last deployments: **Deployments → Rollback** returns to a previous version in one click.
