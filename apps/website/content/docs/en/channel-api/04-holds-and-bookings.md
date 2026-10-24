---
title: Holds and bookings
summary: Holding cabins, confirming with guests, releasing, and reading a booking.
---

# Holds and bookings

## Hold

```bash
curl -s -X POST "$API/v1/holds" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{ "quote_id": "'$QUOTE'", "kind": "checkout" }'
```

| `kind`     | Use it for                                 | Lasts (contract default) |
| ---------- | ------------------------------------------ | ------------------------ |
| `checkout` | Your customer is paying on your site now   | 30 minutes               |
| `option`   | An agent's option while the client decides | 72 hours                 |

The cabins are reserved on every leg until `expires_at`. If there is no room, the call fails with `NOT_AVAILABLE`. When an abandoned hold should end early, release it: `DELETE /v1/holds/{id}`. Expired holds release themselves, and you receive `hold.expired`.

## Confirm

```bash
curl -s -X POST "$API/v1/holds/$HOLD/confirm" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "channel_ref": "NC-50211",
    "guests": [
      { "cabin": 0, "first_name": "Emma", "last_name": "Clarke", "lead": true, "nationality": "GB" }
    ]
  }'
```

- `channel_ref` is **your** booking number. It is unique per channel, for good: confirming again with the same `channel_ref` returns the existing booking. That is your safety net after a long outage.
- Exactly one guest is the **lead**. `cabin` is the index of the cabin in the quote, from 0.
- `passport_number` and `date_of_birth` are accepted, encrypted, and never returned.

The result is the **booking**, with its reference (for example `VS-26-00611`) and status:

| Status      | Meaning                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `confirmed` | Done                                                                                                   |
| `requested` | Your contract is on credit and you are over your limit (`reason: "credit_limit"`): the company decides |

## Read a booking

```bash
curl -si "$API/v1/bookings/$REF" -H "$H"
```

The response has the sailing and its legs, cabins and guest names, totals, payments due and the current **revision**. The revision is also the `ETag` header, and you send it when you [amend](/docs/channel-api/changes-and-cancellations). You can only read your own bookings: another channel's booking is `404`.
