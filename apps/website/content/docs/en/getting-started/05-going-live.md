---
title: Going live
summary: Importing your existing bookings and the checklist before the first real booking.
---

# Going live

## 1. Import your existing future bookings

Bookings you already have are imported from a spreadsheet saved as CSV. Use the template at `docs/pilot/import-template.csv` in the Riverdesk repository; the Riverdesk team will send it to you.

**One row per cabin.** Rows that belong to one booking share the same `external_ref` (your current booking number).

| Column                                  | Meaning                                                    | Example                   |
| --------------------------------------- | ---------------------------------------------------------- | ------------------------- |
| `external_ref`                          | Your booking number                                        | `OLD-1002`                |
| `channel_code`                          | Blank for a direct booking, or the agency's code           | `nilecrz`                 |
| `vessel_code`, `itinerary`              | As shown on the Schedule screen                            | `NILEDEMO`, `LXR-7`       |
| `embark_date`                           | Year-month-day                                             | `2026-12-07`              |
| `market`                                | `international` or `egyptian_resident`                     | `international`           |
| `category_code`, `adults`, `child_ages` | The cabin, the adults and children's ages separated by `;` | `SUP`, `2`, `4;8`         |
| `guests`                                | Names in this cabin separated by `\|`                      | `Lukas Weber\|Anna Weber` |
| `nationality`                           | Two letters                                                | `DE`                      |
| `expected_total`                        | The total you agreed, to check against today's rates       | `4876.00`                 |
| `paid_amount`, `paid_reference`         | Money already received, recorded as one payment            | `1200.00`, `TT 7781`      |

How the import behaves:

- Every booking is made exactly like a booking in the office, so it takes real cabins.
- A **dry run** first prices everything and books nothing. It shows what would happen.
- Problems are **reported, never forced**: a date with no sailing, an unknown category, no room left. You fix them by hand.
- If your agreed total differs from today's rates, the booking is made at today's rates and the difference is reported, so you can adjust it.
- Running the same file again is safe: bookings already imported are skipped.

## 2. The go-live checklist

Before the first real booking, the Riverdesk team goes through this with you:

- **Passwords and keys** used during setup are replaced.
- **Two-step sign-in** is set up for every owner and finance person.
- **People and roles** are reviewed: no shared logins.
- **Backups** are verified, including restoring to a chosen minute ("point-in-time recovery").
- **Alerts** reach the office when something needs attention.
- **The nightly outage pack** arrives in your operations inbox.
- **Documents** print correctly in Arabic and English.
- **Online platforms** (such as nilecrz) have tested their connection on a test company.
- **The import** has been checked with your reservations manager.
- **Staff** have each taken a phone booking, answered a request, recorded a payment and printed a voucher.
- **The Pilot dashboard** shows all checks passing and no oversells.
