import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { appRouter } = await import('../server/router');
const { can, MFA_REQUIRED, PERMISSIONS } = await import('../server/permissions');

const staff = (role: 'owner' | 'reservations' | 'finance' | 'read_only') => ({
  staffUserId: crypto.randomUUID(),
  operatorId: crypto.randomUUID(),
  role,
});

describe('back-office authorization (server side)', () => {
  it('refuses calls without a linked staff session', async () => {
    await expect(appRouter.createCaller({ session: null }).me.profile()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses everything until MFA is passed for roles that need it', async () => {
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('owner'),
      needsMfa: true,
    };
    await expect(appRouter.createCaller({ session }).home.actionList()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'MFA_REQUIRED',
    });
  });

  it('owner and finance need MFA; reservations and read-only do not', () => {
    expect([...MFA_REQUIRED].sort()).toEqual(['finance', 'owner']);
  });

  it('read-only may read and do nothing else', () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can('read_only', permission)).toBe(permission === 'read');
    }
    expect(can('finance', 'payments.write')).toBe(true);
    expect(can('finance', 'bookings.write')).toBe(false);
    expect(can('reservations', 'payments.write')).toBe(false);
    expect(can('reservations', 'rates.write')).toBe(false);
    expect(can('owner', 'settings.write')).toBe(true);
  });
});
