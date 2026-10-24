---
title: Requests and offers
summary: On-request contracts — sending a request, the decision, and alternative offers.
---

# Requests and offers

If your contract is **on request** (availability shows `status: "on_request"`), you ask and the cruise company decides. No cabins are taken until it accepts.

## Send a request

```bash
curl -s -X POST "$API/v1/requests" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{ "quote_id": "'$QUOTE'", "channel_ref": "NC-REQ-1",
        "guests": [{ "cabin": 0, "first_name": "Ana", "last_name": "Lopez", "lead": true }] }'
```

The booking comes back with `status: "requested"` and `request_expires_at`, the deadline from your contract (6 hours by default, plus a short grace period).

## The decision

You receive `request.decided` with `data.decision`:

| Decision         | Meaning                                    |
| ---------------- | ------------------------------------------ |
| `accepted`       | The booking is confirmed                   |
| `declined`       | Not possible. The reason is on the booking |
| `timed_out`      | Not answered in time                       |
| `offer_accepted` | You accepted an alternative                |
| `offer_expired`  | An alternative was not accepted in time    |

## Alternative offers

The company may offer another sailing instead. You receive `offer.created` with `offer_id`, `sailing_id` and `expires_at` (48 hours by default). The booking shows the open offer with its price. To take it:

```bash
curl -s -X POST "$API/v1/offers/$OFFER/accept" -H "$H" -H "Idempotency-Key: $(uuidgen)"
```

If you do nothing, the offer expires.
