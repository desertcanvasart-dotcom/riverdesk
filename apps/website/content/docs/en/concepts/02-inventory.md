---
title: Inventory and why it never oversells
summary: Pools, allotments, blocks, holds and the nightly reconciliation check.
---

# Inventory and why it never oversells

## Counted per leg and category

For every leg and every cabin category, Riverdesk keeps counters: how many cabins exist, how many are **held** (reserved for a short time) and how many are **booked**. The free cabins are the difference.

Those cabins are split into **buckets**:

- **The pool**: shared by everyone allowed to sell from it (your office and pool agencies);
- **Allotments**: cabins set aside for one agency, returned to the pool before departure if unused;
- **Blocks**: cabins taken out of sale, for maintenance for example.

## How a booking takes cabins

When a booking or hold is made, Riverdesk takes **one cabin on every leg of the cruise** in one step. Either every leg has room and all are taken, or nothing is taken. Two people booking the last cabin at the same instant cannot both succeed. The database decides who was first, and the other is told _not enough cabins_.

## The reconciliation check

Every night, and after every automated test, Riverdesk checks that everything adds up:

1. The cabins in the buckets match the vessel's actual cabins for that date.
2. The held and booked counts match the individual holds and bookings.
3. Nothing holds or books more than its bucket has.

If anything is ever off, **sales stop on that leg and category at once** and the office is told on Today. Nothing is corrected silently.

## Emergencies

If a booked cabin breaks, an **emergency block** takes it out even though that leaves too few cabins. This is the only time a bucket may be over its limit: the excess is recorded, sales are stopped, and the bookings to move are listed for the office.
