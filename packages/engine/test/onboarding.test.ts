import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { operatorsCreatedHere, owner, testConfig } from '@vs/db/testing';
import { createCompany } from '@vs/db/platform';
import { claimStaffInvitation, getStaffContext, openDatabase, type VsDatabase } from '../src/index';

describe('company onboarding (platform command + first sign-in)', () => {
  let backoffice: VsDatabase;
  let api: VsDatabase;
  let admin: pg.Client;
  const slug = `co-${randomUUID().slice(0, 8)}`;
  const email = `Owner.${slug}@Example.test`;

  beforeAll(async () => {
    const config = testConfig();
    backoffice = openDatabase('vs_backoffice', { config, max: 2 });
    api = openDatabase('vs_api', { config, max: 1 });
    admin = new pg.Client({ connectionString: config.DATABASE_URL_ADMIN });
    await admin.connect();
  });

  afterAll(async () => {
    await admin.end();
    await backoffice.close();
    await api.close();
  });

  it('creates the company, its settings, back-office channel and an owner invitation', async () => {
    const created = await createCompany(admin, {
      name: 'Nile Dream Cruises',
      slug,
      bookingRefPrefix: 'NDM',
      ownerEmail: email,
      ownerName: 'Mona Hassan',
    });
    operatorsCreatedHere().add(created.operatorId);
    const { rows } = await owner().query(
      `select o.name, s.booking_ref_prefix, c.type as channel, i.email, i.role
       from vs.operator o join vs.operator_setting s on s.operator_id = o.id
       join vs.channel c on c.operator_id = o.id join vs.staff_invitation i on i.operator_id = o.id
       where o.id = $1`,
      [created.operatorId],
    );
    expect(rows).toEqual([
      {
        name: 'Nile Dream Cruises',
        booking_ref_prefix: 'NDM',
        channel: 'back_office',
        email: email.toLowerCase(),
        role: 'owner',
      },
    ]);
  });

  it('the invited email claims the owner role once, on first sign-in; others get nothing', async () => {
    const authUserId = randomUUID();
    expect(await getStaffContext(backoffice, authUserId)).toBeNull();
    expect(
      await claimStaffInvitation(backoffice, randomUUID(), 'someone.else@example.test'),
    ).toBeNull();

    const staff = await claimStaffInvitation(backoffice, authUserId, email.toUpperCase()); // case-insensitive
    expect(staff).toMatchObject({ role: 'owner' });
    expect(await getStaffContext(backoffice, authUserId)).toEqual(staff);
    // Claiming again returns the same link; a second person with the same email gets nothing.
    expect(await claimStaffInvitation(backoffice, authUserId, email)).toEqual(staff);
    expect(await claimStaffInvitation(backoffice, randomUUID(), email)).toBeNull();
    const audit = await owner().query(
      `select 1 from vs.audit_log where action = 'staff_invitation.accepted' and operator_id = $1`,
      [staff!.operatorId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('an expired invitation cannot be claimed; the API role cannot claim at all', async () => {
    const other = `co-${randomUUID().slice(0, 8)}`;
    const otherEmail = `${other}@example.test`;
    const created = await createCompany(admin, {
      name: 'Expired Co',
      slug: other,
      bookingRefPrefix: 'EXP',
      ownerEmail: otherEmail,
      ownerName: 'X',
    });
    operatorsCreatedHere().add(created.operatorId);
    await owner().query(
      `update vs.staff_invitation set expires_at = now() - interval '1 second' where operator_id = $1`,
      [created.operatorId],
    );
    expect(await claimStaffInvitation(backoffice, randomUUID(), otherEmail)).toBeNull();
    await expect(claimStaffInvitation(api, randomUUID(), otherEmail)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('refuses a second company with the same slug', async () => {
    await expect(
      createCompany(admin, {
        name: 'Dup',
        slug,
        bookingRefPrefix: 'DUP',
        ownerEmail: `dup-${slug}@example.test`,
        ownerName: 'D',
      }),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
