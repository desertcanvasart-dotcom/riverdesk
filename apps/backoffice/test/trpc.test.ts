import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { appRouter } = await import('../server/router');

describe('back-office tRPC', () => {
  it('rejects staff procedures without a linked staff user', async () => {
    const caller = appRouter.createCaller({ staff: null });
    await expect(caller.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns the staff context for a linked user', async () => {
    const staff = {
      staffUserId: crypto.randomUUID(),
      operatorId: crypto.randomUUID(),
      role: 'reservations' as const,
    };
    const caller = appRouter.createCaller({ staff });
    expect(await caller.me()).toEqual(staff);
  });
});
