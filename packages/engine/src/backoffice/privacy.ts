import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { decryptField, fieldKeyring, loadConfig, type FieldKeyring } from '@vs/shared';
import { audit } from '../audit';
import { ERASED_CHECKIN_DETAILS } from '../booking/common';
import { parseInput, type EngineContext } from '../internal';

/**
 * Data subject requests (spec § Sensitive data): everything held about one guest, or erasing it.
 * Owner only (checked by the back office). Both are audited without the values.
 */

let keyring: FieldKeyring | undefined;
const keys = () => (keyring ??= fieldKeyring(loadConfig()));

export const guestRequestInput = z.object({ guestId: z.uuid() });

export async function exportGuestData(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof guestRequestInput>,
) {
  const data = parseInput(guestRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      first_name: string;
      last_name: string;
      nationality: string | null;
      date_of_birth: string | null;
      lead: boolean;
      passport_ciphertext: Buffer | null;
      passport_key_id: string | null;
      details: Record<string, unknown>;
      visa_ciphertext: Buffer | null;
      visa_key_id: string | null;
      medical_ciphertext: Buffer | null;
      medical_key_id: string | null;
      created_at: Date;
      booking_id: string;
      booking_cabin_id: string;
      ref: string;
      status: string;
      embark_date: string;
      disembark_date: string;
      vessel: string;
      operator: string;
    }>`
      select g.first_name, g.last_name, g.nationality, g.date_of_birth::text, g.lead, g.passport_ciphertext,
             g.passport_key_id, g.visa_ciphertext, g.visa_key_id, g.medical_ciphertext, g.medical_key_id,
             jsonb_strip_nulls(jsonb_build_object(
               'title', g.title, 'gender', g.gender, 'passportCountry', g.passport_country,
               'passportIssuedOn', g.passport_issued_on, 'passportExpiresOn', g.passport_expires_on,
               'placeOfBirth', g.place_of_birth, 'visaType', g.visa_type, 'arrivalDate', g.arrival_date,
               'arrivalFlight', g.arrival_flight, 'arrivalPort', g.arrival_port,
               'language', g.language, 'departureDate', g.departure_date, 'departureFlight', g.departure_flight,
               'departureTime', to_char(g.departure_time, 'HH24:MI'), 'phone', g.phone,
               'emergencyName', g.emergency_name, 'emergencyPhone', g.emergency_phone,
               'dietary', nullif(g.dietary, '{}'), 'allergies', g.allergies, 'occasion', g.occasion,
               'occasionDate', g.occasion_date)) as details,
             g.created_at, g.booking_id, g.booking_cabin_id, b.ref, b.status, s.embark_date::text, s.disembark_date::text,
             v.name as vessel, o.name as operator
      from vs.guest g join vs.booking b on b.id = g.booking_id join vs.sailing s on s.id = b.sailing_id
      join vs.vessel v on v.id = b.vessel_id join vs.operator o on o.id = g.operator_id
      where g.id = ${data.guestId}`.execute(tx);
    const g = rows[0];
    if (!g) throw new DomainError('NOT_FOUND', { message: 'Guest not found' });
    // The booking's money: its issued invoices and credit notes (as billed), what was received
    // for it, and the folio of the guest's cabin.
    const invoices = await sql<{
      number: string;
      type: string;
      status: string;
      issue_date: string;
      total: bigint;
      currency: string;
      billed_to: string | null;
    }>`
      select i.number, i.type, i.status, i.issue_date::text, i.total, i.currency,
             i.party_snapshot->>'name' as billed_to
      from vs.invoice i
      where i.status <> 'draft'
        and (exists (select from vs.invoice_line l where l.invoice_id = i.id and l.booking_id = ${g.booking_id})
             or i.id in (select f.invoice_id from vs.folio f where f.booking_id = ${g.booking_id}
                         and f.invoice_id is not null))
      order by i.issued_at`.execute(tx);
    const receipts = await tx
      .selectFrom('receipt')
      .select(['received_on', 'kind', 'amount', 'currency', 'method', 'reference'])
      .where('booking_id', '=', g.booking_id)
      .orderBy('received_on')
      .orderBy('created_at')
      .execute();
    const folio = await tx
      .selectFrom('folio')
      .select(['id', 'status', 'currency'])
      .where('booking_cabin_id', '=', g.booking_cabin_id)
      .executeTakeFirst();
    const charges = folio
      ? await tx
          .selectFrom('folio_charge')
          .select(['charged_on', 'description_en', 'quantity', 'amount', 'guest_name'])
          .where('folio_id', '=', folio.id)
          .orderBy('posted_at')
          .execute()
      : [];
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'guest.data_exported',
      entity: 'guest',
      entityId: data.guestId,
      after: { booking: g.ref },
    });
    return {
      controller: g.operator,
      exportedAt: new Date().toISOString(),
      guest: {
        firstName: g.first_name,
        lastName: g.last_name,
        nationality: g.nationality,
        dateOfBirth: g.date_of_birth,
        passportNumber:
          g.passport_ciphertext && g.passport_key_id
            ? decryptField(Buffer.from(g.passport_ciphertext), g.passport_key_id, keys())
            : null,
        ...g.details,
        visaNumber:
          g.visa_ciphertext && g.visa_key_id
            ? decryptField(Buffer.from(g.visa_ciphertext), g.visa_key_id, keys())
            : null,
        medicalNotes:
          g.medical_ciphertext && g.medical_key_id
            ? decryptField(Buffer.from(g.medical_ciphertext), g.medical_key_id, keys())
            : null,
        leadGuest: g.lead,
        recordedAt: g.created_at.toISOString(),
      },
      booking: {
        ref: g.ref,
        status: g.status,
        vessel: g.vessel,
        embarkDate: g.embark_date,
        disembarkDate: g.disembark_date,
      },
      invoices: invoices.rows.map((i) => ({
        number: i.number,
        type: i.type,
        status: i.status,
        issueDate: i.issue_date,
        total: i.total.toString(),
        currency: i.currency,
        billedTo: i.billed_to,
      })),
      payments: receipts.map((r) => ({
        receivedOn: String(r.received_on),
        kind: r.kind,
        amount: r.amount.toString(),
        currency: r.currency,
        method: r.method,
        reference: r.reference,
      })),
      folio: folio && {
        status: folio.status,
        currency: folio.currency,
        charges: charges.map((c) => ({
          chargedOn: String(c.charged_on),
          description: c.description_en,
          quantity: c.quantity,
          amount: c.amount.toString(),
          guestName: c.guest_name,
        })),
      },
    };
  });
}

/**
 * Erases one guest's personal data: name replaced; nationality, date of birth, passport, language
 * and every check-in detail removed. The guest row stays so the cabin's occupancy and the
 * booking's accounts still add up. Also erased: the booking's guest billing party when it was
 * named after this guest (name, contact, address, tax numbers), and the guest's name on folio
 * charges. Kept for accounting: issued invoices and credit notes (their frozen billing details,
 * which tax law requires), receipts and their attached proof of payment.
 */
export async function eraseGuest(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof guestRequestInput>,
) {
  const data = parseInput(guestRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('guest')
      .select(['first_name', 'last_name', 'booking_id'])
      .where('id', '=', data.guestId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Guest not found' });
    const name = `${before.first_name} ${before.last_name}`;
    const erased = await tx
      .updateTable('guest')
      .set({
        first_name: 'Erased',
        last_name: 'Guest',
        nationality: null,
        title: null,
        gender: null,
        language: null,
        ...ERASED_CHECKIN_DETAILS,
        dietary: sql<string[]>`'{}'::text[]`,
      })
      .where('id', '=', data.guestId)
      .returning(['id', 'booking_id'])
      .executeTakeFirstOrThrow();
    // The booking's guest billing parties (found through its receipts, invoices and folios), when
    // named after this guest, as they were made.
    const parties = await tx
      .updateTable('billing_party')
      .set({
        name: 'Erased guest',
        legal_name_ar: null,
        legal_name_en: null,
        address: null,
        tax_registration_no: null,
        commercial_registration_no: null,
        email: null,
        phone: null,
        country: null,
      })
      .where('kind', '=', 'guest')
      .where('name', '=', name)
      .where((eb) =>
        eb.or([
          eb(
            'id',
            'in',
            eb
              .selectFrom('receipt')
              .select('billing_party_id')
              .where('booking_id', '=', erased.booking_id),
          ),
          eb(
            'id',
            'in',
            eb
              .selectFrom('invoice_line as l')
              .innerJoin('invoice as i', 'i.id', 'l.invoice_id')
              .select('i.billing_party_id')
              .where('l.booking_id', '=', erased.booking_id),
          ),
          eb(
            'id',
            'in',
            eb
              .selectFrom('folio as f')
              .innerJoin('invoice as i', 'i.id', 'f.invoice_id')
              .select('i.billing_party_id')
              .where('f.booking_id', '=', erased.booking_id),
          ),
        ]),
      )
      .returning('id')
      .execute();
    const { rows } = await sql<{ n: number }>`
      select vs.erase_folio_guest_name(${erased.booking_id}, ${name}) as n`.execute(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'guest.erased',
      entity: 'guest',
      entityId: erased.id,
      after: {
        booking_id: erased.booking_id,
        billing_parties: parties.length,
        folio_charges: rows[0]!.n,
      },
    });
    return { guestId: erased.id, erased: true };
  });
}
