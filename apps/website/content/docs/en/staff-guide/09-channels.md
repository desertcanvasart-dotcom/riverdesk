---
title: Channels
summary: Agencies and platforms, their contracts, allotments, API keys and webhooks.
---

# Channels

![Channels](/screens/{locale}/desktop-channels.jpg)

A **channel** is anyone who sells your cabins: your own office (_back office_), a travel agency, or an online platform such as a booking engine, an online travel agency or nilecrz. Each channel has a **contract** per vessel. See [Channels and contracts](/docs/concepts/channels-and-contracts) for the ideas behind it.

## The contract

Each contract line shows:

- **Allocation**: _shared pool_ (sells from your free cabins), _allotment_ (its own reserved cabins) or _on request_ (asks first).
- **Payment**: _channel collects_, _prepaid to us_ or _on credit_.
- **Price**: the rate as is, a **markup** or a **commission** (a percentage).
- **Holds**: how long its checkout and option holds last.
- **Answer requests within**: for on-request contracts.

**Stop selling / Resume selling** pauses one channel without touching the others. Owners can add channels and contracts.

## Allotments

An **allotment** sets cabins aside for one agency on chosen departures. **New allotment** (owners and reservations) asks for the date range, the cabins per category and the **release days**. Unused cabins return to general sale that many days before each departure, automatically.

## API clients (online platforms)

A platform's system signs in with an **API client**: a public _client ID_ and a secret.

- **New API client** creates one. The secret is shown **once**, in a box with a **Copy** button. Send it to the platform safely. It cannot be shown again.
- To change a secret without downtime: **Add a second secret**, let the platform switch to it, then **Revoke** the old one.
- Each secret shows when it was last used.

## Webhooks

A **webhook endpoint** is the platform's address that Riverdesk notifies when something changes: a booking confirmed, availability changed. The signing secret is also shown once. **Delivery log** shows every message, delivered, waiting or failed, with **Send again** to replay one.
