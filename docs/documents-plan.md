# Branding and the cruise document library — plan

Status: **approved 2026-10-26 with the recommended answers; Batches D1 (branding), D2 (check-in), D3 (on board) and D4 (the remaining stationery, 2026-10-29) done — the library is complete** (overall order in `analytics-plan.md` § Roadmap). This covers
the owner's request of 2026-10-26: simple, effective branding per company; a well-designed
embarkation sheet; a check-in file with every passenger's full details that can reach the staff on
board for each departure; and the complete set of documents ("stationery") a Nile cruise usually
works with.

Answers taken (the recommendations in § 7):

- Police list: the check-in file uses the field list in § 3 until a real sample arrives, then copies its columns.
- On-board access: an on-board staff login per vessel, plus send-to-vessel email (off by default) and the share sheet.
- Branding scope: documents first (the only guest-facing output today); guest pages follow when they exist.
- Design: one strong template, coloured by each company.
- Guest fields: as listed in § 3, all optional for now.
- Order: D1 (branding) before invoicing F1.

## 1. What exists today

| Document                                                 | Format                                | Notes                                                                                                           |
| -------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Voucher, itinerary, payment schedule, cancellation terms | PDF, AR or EN, full or agency version | Per booking                                                                                                     |
| Passenger manifest                                       | PDF/Excel, AR or EN                   | Per departure (leg); passports only with the `manifests` permission; download audited; file expires after 1 day |
| Rooming list                                             | PDF/Excel                             | Per departure                                                                                                   |
| Weekly vacancy sheet                                     | PDF/Excel/PNG                         | Per vessel                                                                                                      |
| Outage pack                                              | PDF, emailed nightly                  | Next 14 days                                                                                                    |

- **Look:** all documents share one plain layout: the company name as text, a fixed teal colour, no logo.
- **Guest details:** each guest has only first and last name, nationality, date of birth, passport number (encrypted, erased 90 days after disembarkation) and a lead flag.

## 2. Branding (per company, set in Settings → Branding)

Kept deliberately simple: four choices, one strong design.

- **Logo:** PNG or JPEG, up to 200 KB. Shown on every document and the guest-facing pages.
- **Primary colour:** headers, table heads, accents.
- **Secondary colour:** highlights and badges.
  - Riverdesk checks contrast and darkens a colour for text automatically when it would be hard to read, so no choice can make a document illegible.
- **Contact block:** reservations phone and WhatsApp, email, website, address. Printed in every document footer.
- **Live preview:** a voucher and an embarkation sheet update as the colours change, in Arabic and English.
- **Defaults:** the current teal, so nothing changes until a company picks its own.
- **Document language:** every document can be Arabic, English or **both**. Bilingual documents are needed for on-board staff and for police lists.
- **Fonts:** fixed (Tajawal or Noto Arabic with Inter). Arabic typography is the hard part and should not be a per-company choice.

## 3. Guest details for check-in (new, all optional)

Added to each guest, entered in the booking screen, through the Channel API (new optional fields;
existing behaviour unchanged) or imported:

- Title and gender
- Passport: issuing country, issue date, expiry date
- Place of birth
- Visa type and number
- Arrival in Egypt: date, flight, port of entry
- Mobile / WhatsApp
- Emergency contact
- Dietary needs and allergies
- Medical or mobility notes
- Special occasion (birthday, honeymoon, anniversary)

**Protection:** passport and visa numbers, medical notes and dates of birth get the same protection as passport numbers today:

- encrypted
- never written to logs or channel messages
- erased automatically after disembarkation

The exact list follows the police form (question 1).

## 4. The new documents

### 4.1 Embarkation sheet (reception desk, per departure)

- **Layout:** one page per deck or per arrival group, landscape A4, sorted by cabin.
- **Each row shows:**
  - cabin, guests' names, nationality, adults and children
  - booking ref and agency, transfer / arrival time
  - dietary and occasion icons
  - balance still to collect
- **Tick boxes:** passport seen, registration card signed, key handed over.
- **Header and footer:** a summary (cabins, guests, nationalities, special diets) and a signature line for the receptionist.
- **No passport numbers**, so it can sit open on the desk.

### 4.2 Check-in file (full guest details, per departure)

- **One row per guest** with every field from § 3, plus cabin, booking ref and agency.
- **Excel** sorted and ready to forward or upload, and a matching **PDF**.
- **Column order:** follows the tourism-police / foreigners-registration list the vessel files today, so the reception can submit it without retyping (question 1).
- **Confidential:** same rules as the manifest (permission, audited download, file expires after a day).

### 4.3 Getting it to the staff on board

**Recommended: an on-board staff login** (new role `onboard`, limited to one vessel).

- **Access:** the purser or receptionist sees only that vessel's departures on a phone or tablet: the embarkation sheet, the check-in file and the rooming list.
- **Live check-in:** they can tick guests off as they board; the office sees it live.
- **Limits:** no prices or payments, and no other vessel.
- **Why:** passport data stays inside Riverdesk instead of travelling on WhatsApp.

**Also available:**

- **Send to vessel:** the owner presses one button, and the vessel's on-board email gets the files N hours before embarkation (automatic, off by default).
- **Phone share:** the phone's share sheet sends the file itself.

## 5. The full document library

Grouped by when they are used. ✓ exists today; ★ proposed for the first round; the rest follow.

**Before arrival (to the guest or agency)**

- ✓ Booking confirmation / voucher, itinerary, payment schedule, cancellation terms
- Proforma and invoice (in the invoicing plan)
- ★ Pre-departure information: embarkation port, time and place, what to bring, dress code, visa and passport validity, contacts
- Transfer voucher
- E-ticket / boarding pass with QR code
- Luggage tags with name, vessel and cabin

**Embarkation day (reception)**

- ★ Embarkation sheet (§ 4.1)
- ★ Check-in file / police list (§ 4.2)
- ★ Guest registration card: one per guest, pre-filled, signed at the desk (standard in Egyptian hotels)
- ✓ Rooming list
- ★ Cabin door / welcome cards with the guests' names
- Key control list

**On board (operations)**

- ✓ Passenger manifest
- ★ Special diets and allergies list (kitchen and restaurant)
- ★ Special occasions list (cakes and surprises)
- Excursion and guide list: guests per guide and language, per visit
- ★ Daily programme: built from the itinerary; sailing times, meals, visits; one page per day, to print and slide under doors
- Restaurant table plan
- Safety muster list: muster station and life-jacket count per cabin
- Housekeeping cabin status sheet

**Departure**

- ★ Disembarkation and transfer list: who leaves when, flights, luggage times
- Guest folio of extras (drinks, laundry, tips), linked to invoicing
- Feedback form

## 6. Proposed batches (each stops for review)

| Batch | Scope                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | Branding settings and preview; all existing documents redesigned with the brand, logo and contact block; bilingual (AR + EN) option                               |
| D2    | New guest fields (back office, import, Channel API); embarkation sheet; check-in file; registration cards; on-board role with live check-in; send-to-vessel       |
| D3    | On-board operations: diets, occasions, daily programme, disembarkation/transfers, door cards, pre-departure information                                           |
| D4    | The remaining stationery: transfer voucher, boarding pass with QR, luggage tags, excursion/guide list, table plan, muster list, housekeeping sheet, feedback form |

D1 came before invoicing, so invoices are born with the brand and logo. D3 and D4 follow the analytics and invoicing batches (`analytics-plan.md` § Roadmap).

## 7. Questions

1. **Police / foreigners list:** could the owner send one real example of the list a vessel files today (and the guest registration card, if they use one)? The check-in file will copy its columns exactly. Egypt's tourism ministry has been moving hotels, floating hotels included, to submit guest data electronically to the foreigners-security system. Riverdesk can produce the file now and be shaped for that link later, without building it now.
2. **On-board access:** on-board staff login (recommended), email to the vessel, WhatsApp/share only, or all three?
3. **Branding scope:** documents only, or also the guest-facing pages (booking emails, the future agent portal)?
4. **Design:** one strong template coloured by each company (recommended), or two or three layout styles to choose from?
5. **Guest fields:** is the list in § 3 right? Which fields must be **required** before a departure can be checked in?
6. **Order:** do D1 (branding) before invoicing F1/F2, or finish the invoicing foundations first?
7. **Samples:** any existing stationery the owner likes (from their own vessel or another), to match its spirit?
