---
title: Backups, alerts and outages
summary: How your data is kept safe, how you are warned, and what the office does if Riverdesk is unreachable.
---

# Backups, alerts and outages

## Backups

Your data is copied every day by the database provider (Supabase, in the EU). With **point-in-time recovery** turned on, every change is also recorded, so the database can be restored to any minute of the last seven days. The Riverdesk team has rehearsed a full restore and keeps the steps written down.

## Alerts

Riverdesk checks itself every five minutes and warns the team when:

- a **reconciliation check** fails (the nightly check that cabins add up). Sales stop on that departure automatically;
- **holds are not expiring** on time;
- an agency's **unused allotment was not returned** to sale on its date;
- **messages to a channel keep failing** (more than 1 in 10 in the last hour);
- a **payment problem** appears, such as a late balance, or a guest who paid after their cabins were released.

Most of these also appear on your **Today** screen.

## If Riverdesk is unreachable

Every night, Riverdesk emails your operations address an **outage pack**, one PDF per vessel. It has:

- the free cabins on every sailing for the next 14 days;
- for each departure, who is aboard: cabin, category, names and nationality.

During an outage:

1. Use the latest outage pack to answer availability questions and to board guests.
2. Write down any booking you take by phone (guest, sailing, cabins, price).
3. When Riverdesk is back, enter those bookings normally. If a cabin was sold meanwhile, Riverdesk refuses the booking, and you can offer another cabin or date. It never overbooks.

Online platforms connected to Riverdesk are told the service is temporarily unavailable and to try again later.

> Passport numbers are deliberately **not** in the outage pack, because it travels by email.
