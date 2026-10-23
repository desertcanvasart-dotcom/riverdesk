import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { getStaffContext, openDatabase, type VsDatabase } from '../src/index';

describe('staff auth link', () => {
  let backoffice: VsDatabase;
  let api: VsDatabase;
  let operatorId: string;
  const authUserId = randomUUID();
  const inactiveAuthUserId = randomUUID();

  beforeAll(async () => {
    const config = testConfig();
    backoffice = openDatabase('vs_backoffice', { config, max: 1 });
    api = openDatabase('vs_api', { config, max: 1 });
    operatorId = await createOperator('Staff operator');
    await owner().query(
      `insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role, active)
       values ($1, $2, 'mona@example.test', 'Mona', 'reservations', true),
              ($1, $3, 'old@example.test', 'Old', 'finance', false)`,
      [operatorId, authUserId, inactiveAuthUserId],
    );
  });

  afterAll(async () => {
    await backoffice.close();
    await api.close();
  });

  it('maps a Supabase Auth user to one operator and role', async () => {
    const context = await getStaffContext(backoffice, authUserId);
    expect(context).toMatchObject({ operatorId, role: 'reservations' });
  });

  it('returns null for unknown or inactive users', async () => {
    expect(await getStaffContext(backoffice, randomUUID())).toBeNull();
    expect(await getStaffContext(backoffice, inactiveAuthUserId)).toBeNull();
  });

  it('is not callable by the API role', async () => {
    await expect(getStaffContext(api, authUserId)).rejects.toMatchObject({ code: '42501' });
  });
});
