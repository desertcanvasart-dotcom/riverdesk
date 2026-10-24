import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorsCreatedHere, owner, testConfig } from '@vs/db/testing';
import { setPlatformAdmin } from '@vs/db/platform';
import {
  claimStaffInvitation,
  createPlatformCompany,
  isPlatformAdmin,
  listPlatformCompanies,
  openDatabase,
  reinvitePlatformOwner,
  type VsDatabase,
} from '../src/index';

describe('platform area (admins add companies, see counts only)', () => {
  let backoffice: VsDatabase;
  let api: VsDatabase;
  let admin: pg.Client;
  const tag = randomUUID().slice(0, 8);
  const adminEmail = `Admin.${tag}@Example.test`;
  const company = (suffix: string) => ({
    name: `Platform Co ${suffix}`,
    slug: `pl-${tag}-${suffix}`,
    bookingRefPrefix: 'PLT',
    ownerEmail: `owner-${tag}-${suffix}@example.test`,
    ownerName: 'Owner',
    locale: 'en' as const,
  });

  beforeAll(async () => {
    const config = testConfig();
    backoffice = openDatabase('vs_backoffice', { config, max: 2 });
    api = openDatabase('vs_api', { config, max: 1 });
    admin = new pg.Client({ connectionString: config.DATABASE_URL_ADMIN });
    await admin.connect();
    await setPlatformAdmin(admin, adminEmail);
  });

  afterAll(async () => {
    await admin.end();
    await backoffice.close();
    await api.close();
  });

  it('knows its admins by email, case-insensitively; add-admin can take access away', async () => {
    expect(await isPlatformAdmin(backoffice, adminEmail.toUpperCase())).toBe(true);
    expect(await isPlatformAdmin(backoffice, `nobody-${tag}@example.test`)).toBe(false);
    const temp = `temp-${tag}@example.test`;
    await setPlatformAdmin(admin, temp);
    await setPlatformAdmin(admin, temp); // idempotent
    expect(await isPlatformAdmin(backoffice, temp)).toBe(true);
    await setPlatformAdmin(admin, temp, true);
    expect(await isPlatformAdmin(backoffice, temp)).toBe(false);
  });

  it('an admin adds a company whose owner can then claim it; the list shows counts only', async () => {
    const input = company('a');
    const created = await createPlatformCompany(backoffice, adminEmail, input);
    operatorsCreatedHere().add(created.operatorId);

    let row = (await listPlatformCompanies(backoffice, adminEmail)).find(
      (c) => c.id === created.operatorId,
    );
    expect(row).toMatchObject({
      name: input.name,
      slug: input.slug,
      bookingRefPrefix: 'PLT',
      ownerActive: false,
      openInvitations: 1,
      staff: 0,
      vessels: 0,
      bookings: 0,
    });
    expect(Object.keys(row!).sort()).toEqual(
      [
        'bookingRefPrefix',
        'bookings',
        'createdAt',
        'id',
        'name',
        'openInvitations',
        'ownerActive',
        'slug',
        'staff',
        'vessels',
      ].sort(),
    );

    expect(await claimStaffInvitation(backoffice, randomUUID(), input.ownerEmail)).toMatchObject({
      operatorId: created.operatorId,
      role: 'owner',
    });
    row = (await listPlatformCompanies(backoffice, adminEmail)).find(
      (c) => c.id === created.operatorId,
    );
    expect(row).toMatchObject({ ownerActive: true, openInvitations: 0, staff: 1 });

    const log = await owner().query(
      `select admin_email, action from platform.action_log where operator_id = $1`,
      [created.operatorId],
    );
    expect(log.rows).toEqual([
      { admin_email: adminEmail.toLowerCase(), action: 'company.created' },
    ]);
    // A company that already has an owner cannot be re-invited.
    await expect(
      reinvitePlatformOwner(backoffice, adminEmail, {
        operatorId: created.operatorId,
        ownerEmail: `again-${tag}@example.test`,
        ownerName: 'Again',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('re-inviting replaces an expired owner invitation, even to the same email', async () => {
    const input = company('b');
    const created = await createPlatformCompany(backoffice, adminEmail, input);
    operatorsCreatedHere().add(created.operatorId);
    await owner().query(
      `update vs.staff_invitation set expires_at = now() - interval '1 second' where operator_id = $1`,
      [created.operatorId],
    );
    let row = (await listPlatformCompanies(backoffice, adminEmail)).find(
      (c) => c.id === created.operatorId,
    );
    expect(row).toMatchObject({ openInvitations: 0, ownerActive: false });

    await reinvitePlatformOwner(backoffice, adminEmail, {
      operatorId: created.operatorId,
      ownerEmail: input.ownerEmail,
      ownerName: 'Owner',
    });
    row = (await listPlatformCompanies(backoffice, adminEmail)).find(
      (c) => c.id === created.operatorId,
    );
    expect(row).toMatchObject({ openInvitations: 1 });
    expect(await claimStaffInvitation(backoffice, randomUUID(), input.ownerEmail)).toMatchObject({
      operatorId: created.operatorId,
    });
  });

  it('refuses anyone who is not an admin, and the API role entirely', async () => {
    const stranger = `stranger-${tag}@example.test`;
    await expect(listPlatformCompanies(backoffice, stranger)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(createPlatformCompany(backoffice, stranger, company('c'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(listPlatformCompanies(api, adminEmail)).rejects.toMatchObject({ code: '42501' });
    await expect(isPlatformAdmin(api, adminEmail)).rejects.toMatchObject({ code: '42501' });
    // Runtime roles cannot touch the platform schema directly.
    await expect(
      backoffice.withLookupTx((tx) => sql`select * from platform.admin`.execute(tx)),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a duplicate short name is refused without leaving half a company behind', async () => {
    const input = company('a');
    await expect(
      createPlatformCompany(backoffice, adminEmail, {
        ...input,
        ownerEmail: `dup-${tag}@example.test`,
      }),
    ).rejects.toMatchObject({ code: '23505' });
    const { rowCount } = await owner().query(`select 1 from vs.staff_invitation where email = $1`, [
      `dup-${tag}@example.test`,
    ]);
    expect(rowCount).toBe(0);
  });
});
