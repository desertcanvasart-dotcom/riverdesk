---
title: Errors and retries
summary: The error format, every error code, idempotency keys and what to do in each case.
---

# Errors and retries

## The error format

```json
{ "error": { "code": "NOT_AVAILABLE", "message": "Not enough free cabins", "details": {} } }
```

Branch on `code`, never on `message`.

| HTTP | Codes                                                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`: the request does not match the contract (including unknown fields)                                                                               |
| 401  | `UNAUTHENTICATED`: get a new token                                                                                                                                    |
| 403  | `CONTRACT_FORBIDS`, `FORBIDDEN`                                                                                                                                       |
| 404  | `NOT_FOUND`, also for another channel's holds and bookings                                                                                                            |
| 409  | `NOT_AVAILABLE`, `STOP_SALE`, `SAILING_CLOSED`, `HOLD_EXPIRED`, `HOLD_NOT_ACTIVE`, `QUOTE_EXPIRED`, `REVISION_CHANGED`, `INVALID_STATE`, `RETRY_LATER`, `IN_PROGRESS` |
| 422  | `INVALID_OCCUPANCY`, `NO_RATE_FOR_SEASON`, `IDEMPOTENCY_KEY_REUSED`                                                                                                   |
| 429  | `RATE_LIMITED`                                                                                                                                                        |
| 503  | `SERVICE_UNAVAILABLE`                                                                                                                                                 |

## Idempotency keys

Every `POST`, `PATCH` and `DELETE` needs an `Idempotency-Key` header. Use a **new UUID per action**, and the **same one when you retry that action**. Riverdesk remembers keys for 7 days and returns the original result for a repeat.

| Situation                           | What to do                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Timeout or network error on a write | Retry with the **same** key: you get the original result, never a second booking                      |
| `409 IN_PROGRESS`                   | Your first attempt is still running. Wait `Retry-After` seconds, then retry with the same key         |
| `422 IDEMPOTENCY_KEY_REUSED`        | Same key, different body. This is a bug: use a new key per action                                     |
| Retrying after more than 7 days     | Confirm or request again with the same `channel_ref`: the existing booking is returned                |
| `409 RETRY_LATER`                   | Very busy. Retry after `Retry-After`                                                                  |
| `429 RATE_LIMITED`                  | Wait `Retry-After` seconds                                                                            |
| `503 SERVICE_UNAVAILABLE`           | Riverdesk cannot reach its database. Show sailings as on request and retry after `Retry-After` (30 s) |
