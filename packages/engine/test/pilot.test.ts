import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acceptRequest, createRequest, pilotDashboard, staffBook } from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

describe('pilot dashboard', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('shows invariants, zero oversells, request response times and bookings by channel', async () => {
    await staffBook(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      sailingId: await w.sailing('LXR-4', 14),
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'pilot-0001',
    });
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, await w.sailing('LXR-7', 21), [{ cat: 'STD' }]),
      guests: lead,
    });
    await acceptRequest(w.db, w.ctx, { bookingId: request.bookingId });
    await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, await w.sailing('LXR-7', 28), [{ cat: 'STD' }]),
      guests: lead,
    });

    const d = await pilotDashboard(w.db, w.ctx);
    expect(d.invariants).toEqual([]);
    expect(d.oversells.oversold).toBe(0);
    expect(d.requests).toMatchObject({ received: 2, answered: 1, pending: 1 });
    expect(d.requests.p50_minutes).toBeGreaterThanOrEqual(0);
    expect(d.channels.find((c) => c.channel === 'nilecrz')).toMatchObject({
      bookings: 1,
      confirmed: 1,
    });
    expect(d.channels.find((c) => c.channel === 'request-agent')).toMatchObject({
      bookings: 2,
      confirmed: 1,
      requests: 1,
    });
  });
});
