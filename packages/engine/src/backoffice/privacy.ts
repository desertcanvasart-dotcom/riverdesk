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
             g.created_at, b.ref, b.status, s.embark_date::text, s.disembark_date::text,
             v.name as vessel, o.name as operator
      from vs.guest g join vs.booking b on b.id = g.booking_id join vs.sailing s on s.id = b.sailing_id
      join vs.vessel v on v.id = b.vessel_id join vs.operator o on o.id = g.operator_id
      where g.id = ${data.guestId}`.execute(tx);
    const g = rows[0];
    if (!g) throw new DomainError('NOT_FOUND', { message: 'Guest not found' });
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
    };
  });
}

/**
 * Erases one guest's personal data: name replaced, nationality, date of birth and passport
 * removed. The guest row stays so the cabin's occupancy and the booking's accounts still add up.
 */
export async function eraseGuest(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof guestRequestInput>,
) {
  const data = parseInput(guestRequestInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const erased = await tx
      .updateTable('guest')
      .set({
        first_name: 'Erased',
        last_name: 'Guest',
        nationality: null,
        title: null,
        gender: null,
        ...ERASED_CHECKIN_DETAILS,
        dietary: sql<string[]>`'{}'::text[]`,
      })
      .where('id', '=', data.guestId)
      .returning(['id', 'booking_id'])
      .executeTakeFirst();
    if (!erased) throw new DomainError('NOT_FOUND', { message: 'Guest not found' });
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'guest.erased',
      entity: 'guest',
      entityId: erased.id,
      after: { booking_id: erased.booking_id },
    });
    return { guestId: erased.id, erased: true };
  });
}
