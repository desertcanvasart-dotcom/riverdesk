---
title: What Riverdesk is
summary: The parts of Riverdesk, who uses each one, and how they fit together.
---

# What Riverdesk is

Riverdesk is the reservations system for a Nile cruise company. It keeps one exact count of every cabin on every departure, and everything that sells or uses those cabins works from that count. The office takes phone bookings, travel agencies hold allotments, online platforms book through an API, and the vessel prints its manifests. Because there is only one count, a cabin can never be sold twice.

## Who uses what

| Part                | Who                                                                                     | What for                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The back office** | Owners, reservations staff, finance                                                     | The website your office works in every day: bookings, requests, availability, payments, documents                                                      |
| **The Channel API** | Online platforms (booking engines, online travel agencies, nilecrz) and larger agencies | Their own systems check availability and book directly, under their contract with you                                                                  |
| **The worker**      | Nobody directly                                                                         | A background program that expires holds on time, returns unused allotments, sends updates to channels, prepares PDFs and checks the system every night |

You only ever see the back office. The other two parts work behind it.

## The menu

The menu on the left (on a phone: **☰** at the top) groups the screens by what you are doing:

| Section          | Screens                                                               |
| ---------------- | --------------------------------------------------------------------- |
| _(top)_          | **Today**                                                             |
| **Reservations** | New booking, Bookings, Requests (with how many are waiting), Payments |
| **Operations**   | Inventory, Guests & manifests, Vacancy sheet                          |
| **Setup**        | Ships & cabins, Schedule, Rates & policies, Channels                  |
| **Company**      | Settings, Pilot                                                       |

Click a section's name to fold it away, for example **Setup** once your company is running; Riverdesk remembers this on your computer. Opening a screen in a folded section unfolds it. Your name, role and **Sign out** are at the bottom of the menu.

## What a normal day looks like

1. Open **Today**. It lists what needs doing, most urgent first: requests waiting for an answer, holds about to expire, deposits due, guest names missing, cabins to assign. While a ship is still being set up, owners also see **Getting started** there: each setup step, in order.
2. Take phone and WhatsApp bookings on **New booking**: about a minute each.
3. Answer agency **Requests** before their deadline.
4. Record money on **Payments** as it arrives.
5. Before each departure, check **Guests & manifests**, then print the manifest and the rooming list.

## Languages

Every screen and every document exists in Arabic and English. Arabic is the default. Each person can switch language from the top of the screen, and documents can be printed in either language whatever the screen language is.

## Where to go next

- [Signing in for the first time](/docs/getting-started/first-sign-in)
- [People and roles](/docs/getting-started/people-and-roles)
- The [staff guide](/docs/staff-guide/today), one page per screen
