# Integrating nilecrz with the vessel-system Channel API

This guide takes nilecrz from credentials to a confirmed, amended and cancelled booking. The full reference is the OpenAPI contract: `/docs` on any API server (interactive) and `/openapi.yaml` (raw).

## 1. What you get

- **One API client per cruise company.** nilecrz is a channel of each company it sells for and holds one client per company. Calls with a company's credentials see only that company's vessels, and only what its contract with nilecrz allows: vessels, categories, rate plans, pool or allotment, the visible-free cap, hold TTLs and stop-sell.
- **Sandbox.** A separate company, "Sandbox Nile Cruises", runs the demo vessel `SANDBOX` with 18 months of schedule and demo prices. The platform team creates its credentials with `pnpm sandbox:setup`.
- **Base URLs.** `https://api.example.com` is a placeholder until the domain is chosen. Locally the API runs at `http://localhost:4000`.

## 2. Authenticate

OAuth 2.0 client credentials. Tokens last 15 minutes; get a new one when you receive `401 UNAUTHENTICATED`.

```bash
curl -s -X POST "$API/oauth/token" -u "$CLIENT_ID:$CLIENT_SECRET" -d grant_type=client_credentials
# {"access_token":"eyJ…","token_type":"Bearer","expires_in":900}
```

**Rotating secrets.** Ask the company for a second secret. Deploy it, then ask them to revoke the old one. Both work in the meantime.

## 3. Book

Every POST, PATCH and DELETE needs an `Idempotency-Key` header. Use a new UUID per logical action, and reuse it when you retry that action.

```bash
H="Authorization: Bearer $TOKEN"

# What may I sell?
curl -s "$API/v1/vessels" -H "$H"

# Free cabins (max 120 days per call). status: instant | on_request | sold_out
curl -s "$API/v1/availability?vessel=$VESSEL&from=2026-11-02&to=2026-11-30" -H "$H"

# Price it: 2 adults and a 7-year-old in a standard cabin
curl -s -X POST "$API/v1/quotes" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"sailing_id":"'$SAILING'","market":"international","cabins":[{"category_id":"'$STD'","adults":2,"child_ages":[7]}]}'

# Hold during checkout (contract checkout TTL, default 30 min) or as an option (default 72 h)
curl -s -X POST "$API/v1/holds" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"quote_id":"'$QUOTE'","kind":"checkout"}'

# Confirm with the guests; channel_ref is your own reference
curl -s -X POST "$API/v1/holds/$HOLD/confirm" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"channel_ref":"NC-50211","guests":[{"cabin":0,"first_name":"Emma","last_name":"Clarke","lead":true}]}'
```

Prices are integer **minor units**: `{"amount":117000,"currency":"USD"}` is 1,170.00 USD.

**If the checkout is abandoned**, release the hold: `DELETE /v1/holds/{id}`.

**On-request contracts** use `POST /v1/requests` with the quote instead of a hold. Then wait for `request.decided`. If the company offers an alternative (`offer.created`), accept it with `POST /v1/offers/{id}/accept`.

**Agent credit.** On a credit contract, if the agent is over its credit limit, confirm returns `status: "requested"` with `reason: "credit_limit"`. The company decides.

## 4. Change and cancel

```bash
# Read: the ETag is the revision to amend
curl -si "$API/v1/bookings/$REF" -H "$H" | grep -i etag        # ETag: "1"

# Price a change (here: another sailing), then apply it with If-Match
curl -s -X POST "$API/v1/bookings/$REF/amendment-quotes" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"sailing_id":"'$OTHER_SAILING'"}'
curl -s -X POST "$API/v1/bookings/$REF/amendments" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  -d '{"amendment_quote_id":"'$AMENDMENT_QUOTE'"}'

# Cancel: the response shows the penalty from the booking's cancellation policy
curl -s -X POST "$API/v1/bookings/$REF/cancel" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' -d '{"reason":"Guest cancelled"}'

# Guest details, until the manifest cut-off (7 days before embarkation)
curl -s -X PATCH "$API/v1/bookings/$REF/guests" -H "$H" -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"guests":[{"cabin":0,"first_name":"Emma","last_name":"Clarke","lead":true,"nationality":"GB","passport_number":"…"}]}'
```

Passport numbers and dates of birth are accepted but never returned, in any response, event or webhook.

## 5. Retries and duplicates

| Situation                           | What happens                        | What to do                                                                   |
| ----------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| Timeout or network error on a write | It may or may not have happened     | Retry with the **same** `Idempotency-Key`: you get the original result       |
| `409 IN_PROGRESS`                   | Your first attempt is still running | Wait `Retry-After` seconds and retry with the same key                       |
| `422 IDEMPOTENCY_KEY_REUSED`        | Same key, different body            | A bug: use a new key per action                                              |
| Retrying after more than 7 days     | The key has expired                 | Send the same `channel_ref`: confirm or request returns the existing booking |
| `409 RETRY_LATER`                   | Heavy contention                    | Retry after `Retry-After`                                                    |
| `429 RATE_LIMITED`                  | More than 600 requests in a minute  | Wait `Retry-After` seconds                                                   |
| `503 SERVICE_UNAVAILABLE`           | Outage                              | Show sailings as on request; retry after `Retry-After`                       |

Errors share one shape: `{"error":{"code":"NOT_AVAILABLE","message":"…","details":{…}}}`. Branch on `code`, never on `message`.

## 6. Stay in sync: webhooks and the event feed

**Webhooks.** The company registers your endpoint and gives you its signing secret.

- Every event is a POST with these headers:
  - `X-VS-Event-Id: <uuid>`
  - `X-VS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
- Answer `2xx` within 10 seconds. Failed deliveries are retried with backoff for 24 hours.
- Events for one resource arrive in order. Delivery is still at least once, so duplicates are possible.

Verify every delivery:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(
  secret: string,
  rawBody: string,
  header: string,
  now = Math.floor(Date.now() / 1000),
) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=', 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false; // reject replays older than 5 minutes
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

**Ignore what you have already seen.** Keep the highest `resource_version` you applied per `resource_id`. Apply an event only if its version is higher.

```ts
if (event.resource_version <= lastVersion.get(event.resource_id) ?? 0) return; // duplicate or older
```

| Event                                           | Means                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `availability.changed`                          | Free cabins changed on a leg × category (`data.vessel_id`, `leg_id`, `category_id`). Re-read `GET /v1/availability` for the affected dates |
| `sailing.changed`                               | A departure was cancelled, shifted or changed port (`data.change`, `data.status`)                                                          |
| `rate.changed`                                  | Prices of a contracted rate plan changed (existing quotes and bookings keep their prices)                                                  |
| `hold.expired`                                  | One of your holds ran out                                                                                                                  |
| `booking.confirmed` / `.amended` / `.cancelled` | Your booking changed; `GET /v1/bookings/{ref}` for the details                                                                             |
| `booking.paid_unavailable`                      | Paid after its hold expired and the cabins were gone; the company will offer an alternative or refund                                      |
| `request.decided`                               | `data.decision`: `accepted`, `declined`, `timed_out`, `offer_accepted`, `offer_expired`                                                    |
| `offer.created`                                 | An alternative for your request (`data.offer_id`, `data.sailing_id`, `data.expires_at`)                                                    |
| `payment.recorded` / `payment.overdue`          | Money received or a balance overdue on one of your bookings                                                                                |

**After downtime, catch up from the event feed.** Store `next_cursor` after each page; an empty page means you are current.

```bash
curl -s "$API/v1/events?limit=500" -H "$H"
curl -s "$API/v1/events?after=$NEXT_CURSOR&limit=500" -H "$H"
```

The feed only returns events that are fully committed, in commit order, so a cursor never skips one. `GET /v1/availability` is always the source of truth for free cabins.

## 7. Checklist before going live

- [ ] Tokens refreshed on 401; secrets kept server-side only.
- [ ] One `Idempotency-Key` per action, reused on retries; `channel_ref` set on confirm and request.
- [ ] Every webhook signature verified; duplicates ignored by `resource_version`.
- [ ] The event feed used for catch-up after downtime.
- [ ] 409, 422, 429 and 503 handled as in section 5.
- [ ] The sandbox flow passes: quote → hold → confirm → amend → cancel.
