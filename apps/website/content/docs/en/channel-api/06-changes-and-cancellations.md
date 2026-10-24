---
title: Changes and cancellations
summary: Guest details, amendments with the price first, and cancellation with its penalty.
---

# Changes and cancellations

## Guest details

```bash
curl -s -X PATCH "$API/v1/bookings/$REF/guests" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{ "guests": [
        { "cabin": 0, "first_name": "Emma", "last_name": "Clarke", "lead": true,
          "nationality": "GB", "date_of_birth": "1985-04-02", "passport_number": "…" } ] }'
```

This replaces the guest list. It is allowed until the **manifest cut-off** (7 days before embarkation by default).

## Amendments: price first, then apply

1. **Price the change**. Send another `sailing_id`, or the full new list of `cabins`, or both:

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendment-quotes" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{ "sailing_id": "'$OTHER'" }'
```

The answer has the new **quote**, the **changes** (`date`, `category`, `occupancy`, `cabins`), the **fee** from the booking's amendment policy, and the **difference** in price.

2. **Apply it** with the revision you are amending as `If-Match`:

```bash
curl -s -X POST "$API/v1/bookings/$REF/amendments" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'If-Match: "1"' -H 'Content-Type: application/json' \
  -d '{ "amendment_quote_id": "'$AMENDMENT_QUOTE'" }'
```

If the booking changed meanwhile, you get `409 REVISION_CHANGED`: read it again and start over. The old cabins are released and the new ones taken in one step, and the revision goes up by one.

## Cancel

```bash
curl -s -X POST "$API/v1/bookings/$REF/cancel" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' -d '{ "reason": "Guest cancelled" }'
```

The response shows the **penalty**: the share of the total from the cancellation policy the booking was sold under, by days before embarkation (Cairo date). The cabins return to sale at once.
