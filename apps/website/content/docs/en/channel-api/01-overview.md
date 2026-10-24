---
title: Overview
summary: What the Channel API does, the base URL, and the flow from availability to a booking.
---

# Channel API overview

The Channel API lets an online platform or a larger agency sell a cruise company's cabins **directly from its own system**, live. It sells only what that company's contract with you allows. This guide is for the developers who build that connection.

- **REST over HTTPS, JSON** in and out.
- **OAuth 2.0 client credentials**: your server gets a short-lived token. See [Authentication](/docs/channel-api/authentication).
- **The contract** is an OpenAPI 3.1 document, served as `/openapi.yaml` with an interactive reference at `/docs` on every API server.
- **Money** is always an integer in minor units with its currency: `{"amount": 117000, "currency": "USD"}` is USD 1,170.00. KWD, BHD and OMR have three decimals: `{"amount": 1250, "currency": "KWD"}` is KWD 1.250.
- **Markets** are codes such as `international` or `gcc`. Each cruise company keeps its own list; ask it which markets your contract sells.
- **Dates** are cruise dates in Cairo (`YYYY-MM-DD`). Times are ISO 8601 with a time zone.

## One client per company

You are a **channel** of each cruise company you sell for, and you hold one API client per company. A token from a company's client sees only that company, and only the vessels, categories, rate plans and terms of its contract with you.

## The flow

```text
GET  /v1/vessels                         what may I sell?
GET  /v1/availability                    free cabins per sailing and category
POST /v1/quotes                          price a sailing for these cabins and guests
POST /v1/holds                           hold the cabins while your customer checks out
POST /v1/holds/{id}/confirm              confirm with the guests → a booking
GET  /v1/bookings/{ref}                  read it; change it; cancel it
```

On-request contracts send a request instead of a hold ([Requests and offers](/docs/channel-api/requests-and-offers)). Riverdesk tells you about every change with signed [webhooks](/docs/channel-api/events-and-webhooks).

## Guarantees

- **No oversell.** A hold reserves the cabins on every leg of the cruise. Once you hold them, they are yours until the hold expires or is released.
- **Safe retries.** Every write takes an `Idempotency-Key`. Retrying returns the original result. See [Errors and retries](/docs/channel-api/errors-and-retries).
- **Personal data stays put.** Passport numbers and dates of birth are accepted but never returned in any response, event or webhook.
