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
 * channel and an invitation for its first owner, in one transaction, through
 * platform.create_company (shared with the platform area). Runs as the admin user with
 * SET LOCAL ROLE vs_owner, because runtime roles cannot create companies.
 */
export async function createCompany(
  client: pg.ClientBase,
  input: NewCompany,
): Promise<CreatedCompany> {
  await client.query('begin');
  try {
    await client.query('set local role vs_owner');
    const { rows } = await client.query<{
      operator_id: string;
      back_office_channel_id: string;
      invitation_id: string;
    }>(`select * from platform.create_company($1, $2, $3, $4, $5, $6, 'platform:create-company')`, [
      input.name,
      input.slug,
      input.bookingRefPrefix,
      input.ownerEmail,
      input.ownerName,
      input.locale ?? 'ar',
    ]);
    await client.query('commit');
    return {
      operatorId: rows[0]!.operator_id,
      backOfficeChannelId: rows[0]!.back_office_channel_id,
      invitationId: rows[0]!.invitation_id,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/**
 * Lets this verified email into the platform area (it still signs in with a password and the
 * two-step code). Idempotent. `remove` takes the access away again.
 */
export async function setPlatformAdmin(
  client: pg.ClientBase,
  email: string,
  remove = false,
): Promise<void> {
  await client.query('begin');
  try {
    await client.query('set local role vs_owner');
    const address = email.trim().toLowerCase();
    if (remove) await client.query('delete from platform.admin where email = $1', [address]);
    else
      await client.query(
        `insert into platform.admin (email, added_by) values ($1, 'platform:add-admin')
         on conflict (email) do nothing`,
        [address],
      );
    await client.query(`insert into platform.action_log (admin_email, action) values ($1, $2)`, [
      address,
      remove ? 'admin.removed' : 'admin.added',
    ]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
