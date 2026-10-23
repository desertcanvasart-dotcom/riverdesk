import type pg from 'pg';

export interface NewCompany {
  name: string;
  /** Lower-case, used in URLs and logs. */
  slug: string;
  /** Booking reference prefix, 2–5 capital letters (e.g. NDM → NDM-26-00042). */
  bookingRefPrefix: string;
  ownerEmail: string;
  ownerName: string;
  locale?: 'ar' | 'en';
}

export interface CreatedCompany {
  operatorId: string;
  backOfficeChannelId: string;
  invitationId: string;
}

/**
 * Platform task (agreed 2026-10-24): creates a cruise company with its settings, its back-office
 * channel and an invitation for its first owner, in one transaction. Runs as the admin user with
 * SET LOCAL ROLE vs_owner, because runtime roles cannot create companies.
 */
export async function createCompany(
  client: pg.ClientBase,
  input: NewCompany,
): Promise<CreatedCompany> {
  await client.query('begin');
  try {
    await client.query('set local role vs_owner');
    const operator = await client.query<{ id: string }>(
      `insert into vs.operator (name, slug, default_locale) values ($1, $2, $3) returning id`,
      [input.name, input.slug, input.locale ?? 'ar'],
    );
    const operatorId = operator.rows[0]!.id;
    await client.query(
      `insert into vs.operator_setting (operator_id, booking_ref_prefix) values ($1, $2)`,
      [operatorId, input.bookingRefPrefix],
    );
    const channel = await client.query<{ id: string }>(
      `insert into vs.channel (operator_id, code, name, type)
       values ($1, 'back-office', 'Back office (phone, WhatsApp, walk-in)', 'back_office') returning id`,
      [operatorId],
    );
    const invitation = await client.query<{ id: string }>(
      `insert into vs.staff_invitation (operator_id, email, display_name, role) values ($1, lower($2), $3, 'owner') returning id`,
      [operatorId, input.ownerEmail, input.ownerName],
    );
    await client.query(
      `insert into vs.audit_log (operator_id, actor_type, actor_label, action, entity, entity_id, diff)
       values ($1, 'system', 'platform:create-company', 'operator.created', 'operator', $1, $2)`,
      [
        operatorId,
        JSON.stringify({
          name: { from: null, to: input.name },
          slug: { from: null, to: input.slug },
          owner_invited: { from: null, to: true },
        }),
      ],
    );
    await client.query('commit');
    return {
      operatorId,
      backOfficeChannelId: channel.rows[0]!.id,
      invitationId: invitation.rows[0]!.id,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
