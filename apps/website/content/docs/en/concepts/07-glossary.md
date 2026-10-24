---
title: Glossary
summary: Every term used in Riverdesk, in plain words.
---

# Glossary

**Allotment**: Cabins set aside for one agency on chosen departures. Unused ones return to general sale a set number of days before departure.

**Amendment**: A change to a confirmed booking (date, cabins, occupancy). It is priced first, may carry a fee, and creates a new revision.

**API client**: The login an online platform's system uses: a client ID and a secret.

**Audit log**: The record of every action: who, what, when. It never contains personal data such as passports.

**Back office**: The Riverdesk website your staff work in.

**Block**: Cabins taken off sale. An **emergency block** can take out a cabin even when it is booked.

**Booking reference**: The code of a booking, for example `VS-26-00610`. The letters are your company's prefix.

**Bucket**: One group of cabins on one leg and category: the pool, an allotment or a block.

**Cabin map**: The cabins of one departure drawn deck by deck on Guests & manifests, showing who is in each and letting staff move a party with two clicks.

**Channel**: Anyone who sells your cabins: your office, an agency, a platform.

**Contract**: The terms a channel sells under for one vessel.

**Cut-off**: The day before departure after which guest details are fixed and cabins are assigned (7 days by default).

**Deposit / balance**: The first payment due, and the rest.

**Event / webhook**: A change Riverdesk announces to channels, and the message sent to their system.

**Exception**: Something the system could not decide alone. It appears on Today.

**Getting started**: The list on Today that shows owners, ship by ship, which setup steps are left before the office can sell.

**Hold**: Cabins reserved for a short time before confirmation. It expires on its own.

**Idempotency key**: A unique code a channel sends with each action, so repeating the action never does it twice.

**Invariant**: A rule that must always be true, such as "never more booked than exists". It is checked every night.

**Itinerary (sailing pattern)**: A cruise you sell on the route, for example 4 nights from Luxor.

**Leg (departure)**: The vessel sailing from one boarding port to the next. Cabins are counted per leg.

**Manifest**: The passenger list for a departure. It is the only export with passport numbers.

**Market**: Who a price is for, such as International, Egyptian resident or Gulf (GCC). Each company keeps its own list in Settings; a market can require proof of residency or ID at boarding.

**On request**: A contract where the agency asks and the office decides.

**Option**: An agency's hold, 72 hours by default.

**Outage pack**: The nightly PDF of the next 14 days, emailed so the office can work if Riverdesk is unreachable.

**Pool**: The cabins shared by your office and pool agencies.

**Quote**: A priced proposal for one sailing and set of cabins, the step before a hold.

**Rate plan**: A price list for one market and currency.

**Revision**: One version of a booking. Each change adds one.

**Rooming list**: Each cabin with its guests, for the crew. It has no passports.

**Route (schedule template)**: A ship's repeating cycle of stops, for example Luxor → Aswan → Luxor every 7 days. Departures are made from it.

**Sailing**: One itinerary on one date.

**Season**: A date range with its own prices.

**Stop sale**: Pausing sales on chosen departures and categories, or for one channel.

**Supplement**: An extra charge on certain dates, such as a gala dinner.

**Two-step sign-in (MFA)**: A code from a phone app, required for owners and finance.

**Vacancy sheet**: The list of free cabins for the coming weeks, to send to agencies.

**Worker**: The background program that expires holds, returns allotments, sends webhooks, makes documents and runs the nightly checks.
