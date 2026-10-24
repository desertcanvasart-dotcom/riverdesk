---
title: Sandbox and going live
summary: Testing on the sandbox company, and the checklist before selling for real.
---

# Sandbox and going live

## The sandbox

A separate test company, **Sandbox Nile Cruises**, runs a demo vessel with 18 months of departures and demo prices. Ask the Riverdesk team for a sandbox API client. Everything works exactly as on a real company, including webhooks, and nothing you do there touches real bookings.

## Before going live

- [ ] Tokens are refreshed on `401`; secrets live on your server only.
- [ ] One `Idempotency-Key` per action, reused on retries; `channel_ref` set on every confirm and request.
- [ ] Every webhook signature is verified; duplicates are ignored by `resource_version`.
- [ ] The event feed is used to catch up after downtime.
- [ ] `409`, `422`, `429` and `503` are handled as in [Errors and retries](/docs/channel-api/errors-and-retries).
- [ ] The full flow passes on the sandbox: quote → hold → confirm → guests → amend → cancel, with the webhooks received.

## Reference

The exact request and response of every endpoint is in the interactive reference at `/docs` on the API server, generated from the same contract the server is tested against.
