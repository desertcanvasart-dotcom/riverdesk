---
title: Holds, requests and booking states
summary: The life of a booking from first hold to completion, and every state it can be in.
---

# Holds, requests and booking states

## Holds

A **hold** reserves cabins for a short time before a booking is confirmed:

| Kind     | For                                      | Default length |
| -------- | ---------------------------------------- | -------------- |
| Checkout | A guest paying on a channel's website    | 30 minutes     |
| Option   | An agency's option                       | 72 hours       |
| Offer    | An alternative date offered on a request | 48 hours       |
| Payment  | A direct booking waiting for its deposit | 24 hours       |

Holds expire **on their own** at the exact time: the worker releases them every minute, and nothing depends on someone remembering.

## Booking states

| State                          | Meaning                                                       | Comes from                                                 |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| **Requested**                  | An agency asked; no cabins taken yet                          | An on-request contract, or an agency over its credit limit |
| **Alternative offered**        | You proposed another sailing                                  | A request                                                  |
| **Waiting for payment** (held) | Cabins held until the deposit arrives                         | A direct (prepaid) booking                                 |
| **Confirmed**                  | Cabins booked                                                 | Confirmation, an accepted request, a paid deposit          |
| **Paid, cabin unavailable**    | Money arrived after the hold ran out and the cabins were sold | A late payment, needing a decision                         |
| **Declined**, **Expired**      | A request that was turned down or not answered in time        | A request                                                  |
| **Cancelled**                  | Cancelled, with the penalty from its policy                   | Staff or a channel                                         |
| **Completed**                  | The cruise is over                                            | Automatic, after the last night                            |

## Revisions

Every confirmed change (date, cabins, guests' occupancy) creates a new **revision** with its price and fee. The history is never overwritten. Each revision also keeps a copy of the policies the booking was sold under.
