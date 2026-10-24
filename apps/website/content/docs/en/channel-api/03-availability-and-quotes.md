---
title: Availability and quotes
summary: What you may sell, free cabins per sailing, and pricing a booking.
---

# Availability and quotes

## What you may sell

```bash
curl -s "$API/v1/vessels" -H "Authorization: Bearer $TOKEN"
```

This returns the vessels in your contract, each with the cabin categories you may sell.

## Sailings

```bash
curl -s "$API/v1/sailings?vessel=$VESSEL&from=2026-11-01&to=2026-11-30" -H "$H"
```

Open sailings embarking in the range (at most 400 days), with itinerary code, embark and disembark ports and dates, and nights. Filter by `nights` if you only sell one length.

## Availability

```bash
curl -s "$API/v1/availability?vessel=$VESSEL&from=2026-11-02&to=2026-11-30" -H "$H"
```

For each sailing and contracted category (at most 120 days per call):

| Field        | Meaning                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `status`     | `instant`: you can hold and confirm; `on_request`: your contract asks first; `sold_out`                                        |
| `free`       | Cabins you can take on every leg of the cruise: your allotment plus the shared pool, capped if your contract has a visible cap |
| `from_price` | Per person at double occupancy, on the cheapest plan you may sell                                                              |

Availability is always the source of truth. Re-read it when you receive `availability.changed`.

## Quotes

A quote prices one sailing for given cabins and guests under your contract:

```bash
curl -s -X POST "$API/v1/quotes" -H "$H" -H "Idempotency-Key: $(uuidgen)" \
  -H 'Content-Type: application/json' \
  -d '{
    "sailing_id": "'$SAILING'",
    "market": "international",
    "cabins": [{ "category_id": "'$STD'", "adults": 2, "child_ages": [7] }]
  }'
```

The response has the **total**, every **line** (adults, children by age band, supplements, your markup or commission) and the **policies** that will apply (cancellation, payment). Children's ages are their ages **on the embark date**.

A quote can fail with:

- `INVALID_OCCUPANCY`: too many guests for the category;
- `NO_RATE_FOR_SEASON`: no price set for that date;
- `CONTRACT_FORBIDS`: not in your contract;
- `SAILING_CLOSED`: the sailing is closed.

A quote lasts as long as the longest hold it can back.
