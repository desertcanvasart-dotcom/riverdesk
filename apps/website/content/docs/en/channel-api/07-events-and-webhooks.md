---
title: Events and webhooks
summary: Signed webhooks, ordering and duplicates, the event types, and catching up from the feed.
---

# Events and webhooks

Every change that concerns you is an **event**. Riverdesk sends each one to your webhook endpoint, and you can also read them all from the **event feed**.

## Webhooks

The company registers your endpoint and gives you its **signing secret**. Each event is a `POST` with:

- `X-VS-Event-Id: <uuid>`
- `X-VS-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`

Answer `2xx` within 10 seconds. A failed delivery is retried with growing pauses for 24 hours. The company can see every attempt and send one again.

**Verify every delivery** before trusting it:

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
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false; // older than 5 minutes: reject
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

## Order and duplicates

Events about one resource (one booking, one hold) arrive **in order**: a later one waits until the earlier is delivered. Delivery is **at least once**, so you may see an event twice. Keep the highest `resource_version` you applied per `resource_id`, and ignore anything not newer.

## Event types

| Event                                                       | Means                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `availability.changed`                                      | Free cabins changed on a leg and category. Re-read availability for those dates                      |
| `sailing.changed`                                           | A departure was cancelled, moved or changed port                                                     |
| `rate.changed`                                              | Prices of a plan you sell changed. Existing quotes and bookings keep theirs                          |
| `hold.expired`                                              | One of your holds ran out                                                                            |
| `booking.confirmed`, `booking.amended`, `booking.cancelled` | Your booking changed. Read it for details                                                            |
| `booking.paid_unavailable`                                  | Paid after its hold expired and the cabins were gone. The company will offer another cabin or refund |
| `request.decided`                                           | A decision on your request (see [Requests and offers](/docs/channel-api/requests-and-offers))        |
| `offer.created`                                             | An alternative was offered for your request                                                          |
| `payment.recorded`, `payment.overdue`                       | Money received, or a balance overdue, on your booking                                                |

## Catching up: the event feed

After downtime, read the feed from your last cursor:

```bash
curl -s "$API/v1/events?limit=500" -H "$H"
curl -s "$API/v1/events?after=$NEXT_CURSOR&limit=500" -H "$H"
```

Store `next_cursor` after each page. An empty page means you are up to date. The feed returns events only once they are fully committed, in commit order, so a cursor never skips one.
