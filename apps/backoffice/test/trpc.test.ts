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

  it('every mutation refuses a read-only user before touching its input', async () => {
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('read_only'),
      needsMfa: false,
    };
    const caller = appRouter.createCaller({ session }) as unknown as Record<
      string,
      Record<string, (input: unknown) => Promise<unknown>>
    >;
    const mutations = Object.entries(appRouter._def.procedures)
      .filter(([, procedure]) => (procedure as { _def: { type: string } })._def.type === 'mutation')
      .map(([path]) => path)
      // Changing one's own language is allowed to everyone.
      .filter((path) => path !== 'me.setLocale');
    expect(mutations).toEqual(
      expect.arrayContaining(['book.create', 'bookings.cancel', 'requests.accept']),
    );
    for (const path of mutations) {
      const [group, name] = path.split('.') as [string, string];
      await expect(caller[group]![name]!({}), path).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });
});
