---
title: Analytics
summary: Occupancy, booking pace, channels, markets, booking behaviour, cash, revenue and receivables — how the company is doing, how each figure is counted, and Excel exports.
---

# Analytics

**Analytics** (under Today) shows how bookings are going. Choose a vessel at the top, or leave **All vessels**. Owners and finance also see money; reservations and read-only staff see the same screens without it.

![Analytics overview](/screens/{locale}/guide-analytics.jpg)

## Overview

| Figure                                             | How it is counted                                                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Occupancy** (next 30, 60, 90 days; last 30 days) | Cabin-nights booked ÷ cabin-nights on sale, over the departures in the period. Cabins on sale are the pool and agency allotments; blocked cabins are not on sale                               |
| **Booked in the last 7 days / this month**         | Bookings confirmed in the period (Cairo dates), whatever happened to them later, with cabins and, for owners and finance, the value per currency: what guests pay and the net after commission |
| **On the books, next 90 days**                     | Cabins confirmed for sailings in the next 90 days, now, compared with what the nightly record saw 7 and 28 nights ago                                                                          |
| **Requests answered in time**                      | Requests received in the last 30 days answered (accepted, declined or offered) before their deadline; how many were booked and how many are waiting                                            |
| **Cancellations this month**                       | Bookings cancelled this month ÷ bookings confirmed this month                                                                                                                                  |

**Last year** always means the same calendar dates a year earlier. Until the company has bookings from a year ago, the screen says there is nothing to compare yet.

## Occupancy and pace

![Occupancy and pace](/screens/{locale}/guide-analytics-occupancy.jpg)

Choose the first day and 30, 60 or 90 days.

- **Occupancy by cabin category**: which categories fill first and which stay empty.
- **Booking pace**: for the sailing chosen in the list, cabins on the books night by night as embarkation approaches, against the sailings that embarked on the same date a year earlier. Point at the chart for the figures of any night.
- **Sailings by cabin category**: every sailing in the period against every category, lighter for emptier. Point at a cell for its cabin-nights.
- **Sailings**: each sailing's own cabins booked, cabins on hold, the occupancy of its departures and, for owners and finance, its value. A sailing's occupancy also counts longer cruises that share its departures. Choose a row to see its pace.

## Channels and markets

![Channels and markets](/screens/{locale}/guide-analytics-channels.jpg)

These two tabs share a filter row: the period **by booking date** (when bookings were confirmed) or **by embarkation date** (when their sailings leave), with quick choices, then **channel**, **market** and **cabin category**. A booking counts whatever happened to it later; a cancelled booking shows in **Cancelled**.

- **By channel**: bookings, cabins and cabin-nights, each channel's share of the cabins, how many were cancelled, requests received → booked with the median answer time, and for owners and finance the value per currency and per cabin-night.
- **By market**: bookings, cabins, guests per booking and the share of bookings with children.
- **Guests by nationality**: the ten most common, as a share of guests.
- **Agency allotments**: on departures in the period, the cabins given to each agency, sold, on hold, released back unsold and still open, and the share sold.

## Booking behaviour

- **How far ahead guests book**: bookings by days between confirmation and embarkation, with the median and average.
- **Cruise length chosen** and the **most booked itineraries**.
- **Holds**: placed in the period by kind, the share that became bookings, how many expired or are still active, and how long they lasted on average.
- **When cancellations happen**: how many days before embarkation, and for owners and finance the penalties kept.
- **Amendments**: how many, on how many bookings, what changed (date, cabin category, guests, cabins), and for owners and finance the fees charged.

## Cash (owners and finance)

![Cash](/screens/{locale}/guide-analytics-cash.jpg)

Money only, per currency. Choose the period and whether to see it by day, week or month.

- **Cash in**: money received by the day it arrived, less refunds and reversals, against what **fell due** in the same period — issued invoices by due date (less credit notes) and the balance of bookings the guest pays the ship for that are not invoiced yet.
- **Still to be paid**: what is owed, by when it falls due — overdue, the next 4 weeks, weeks 5–8, weeks 9–12, later. It counts open invoices by due date and, for guest-paid bookings not invoiced, the missing deposit (due now) and the balance (by its due date). Agency bookings not invoiced yet have no due date until they are, so they have their own column.
- **By method**: receipts and net per payment method.
- **Held for coming sailings**: what has been paid on bookings whose sailing has not embarked yet, by sailing month, with what is still to be paid on them; and money received from agencies that is not on an invoice yet.

Choosing a vessel leaves out money received from agencies and platforms as a whole, which belongs to no vessel.

## Revenue (owners and finance)

![Revenue](/screens/{locale}/guide-analytics-revenue.jpg)

Choose the period **by embarkation date** or **by booking date**, and group by vessel, channel or market. Every table on this tab is about the same bookings: confirmed and completed ones at their total and fees, cancelled ones at the penalty and fees kept.

- **Revenue**: by month and group, per currency — booked, the agency commission in it, net, invoiced (on issued invoices less credit notes, before tax) and not yet invoiced.
- **In EGP**: one figure for all currencies. Invoiced amounts use each invoice's own rate; the rest uses the latest rate typed on an invoice in that currency, with its date. The rates used are listed under the figure; a currency with no rate yet is named and left out.
- **What is not kept as revenue**: agency commission, refunds paid out, penalties and amendment fees kept, and discounts (credit notes on bookings that were not cancelled).
- **Currency exposure**: as of today, per currency — bookings still to sail with what is paid and still due, open invoices, and money received that is not on an invoice yet.
- **Extras on board** (when folios are used): what guests spent on board, counted with their booking — charged (voids deducted), invoiced, the guest-nights of every booking in the row and the spend per guest-night, then the totals by category. Extras are not in the revenue figures above, which are about cabins.

![Extras on board](/screens/{locale}/guide-analytics-extras.jpg 'Extras on board on the Revenue tab.')

## Receivables (owners and finance)

![Receivables](/screens/{locale}/guide-analytics-receivables.jpg)

- **What each party owes, and how fast it pays**: open invoices by how late they are as of today (the same figures as **Invoices → Receivables**), money received not yet on an invoice, and over the period you choose (a year by default) the **days to pay** — from the invoice date to the day the money arrived, averaged by amount (a deposit paid before the invoice counts as 0) — and the share of that money **paid by the due date**. Money taken back off an invoice does not count. Choose a party to open its statement.
- **Credit used**: each agency with a credit limit — confirmed bookings not invoiced plus open invoices, less money paid not yet on an invoice — against its limit. The bar turns amber above 80% and red over the limit.

## Excel

Every tab has **Export to Excel**. The file has one sheet per table, with the same figures and filters as the screen, in the screen's language, with your logo and colours. Money columns are included only for owners and finance. Files are kept for a week.

## The nightly record

Every night Riverdesk records what is on the books for every coming departure and sailing. Pace and the 7- and 28-night comparisons come from that record, so they fill in as nights pass. When the record started, earlier nights were rebuilt once from booking dates; they are marked **\*** and are estimates (holds, blocked cabins and changes of those nights are not known).
