import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  acceptOffer,
  acceptRequest,
  createHold,
  createRequest,
  declineRequest,
  expireHolds,
  expireRequests,
  offerAlternative,
  releaseHold,
} from '../src/index';
import {
  bookingWorld,
  counters,
  expireNow,
  lead,
  legsOf,
  type BookingWorld,
} from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );
const statusOf = async (bookingId: string) =>
  (
    await owner().query<{ status: string }>(`select status from vs.booking where id = $1`, [
      bookingId,
    ])
  ).rows[0]!.status;
const pool = async (legId: string, categoryId: string) =>
  (await counters(legId, categoryId)).find((c) => c.kind === 'pool')!;

describe('requests and offers', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('request → accept (credit agent): no inventory until accepted, then booked on every leg', async () => {
    const sailing = await w.sailing('LXR-7', 14);
    const [legA, legB] = await legsOf(sailing);
    const std = w.demo.categories.STD;
    const quoteId = await w.quote(w.agents.onRequest, sailing, [{ cat: 'STD' }]);
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId,
      guests: lead,
    });
    expect(request.status).toBe('requested');
    expect(await pool(legA!, std)).toMatchObject({ held: 0, booked: 0 });
    const { rows } = await owner().query<{ hours: number }>(
      `select round(extract(epoch from request_expires_at - created_at) / 3600)::int as hours from vs.booking where id = $1`,
      [request.bookingId],
    );
    expect(rows[0]!.hours).toBe(8); // SLA 6 h + grace 2 h

    const accepted = await acceptRequest(w.db, w.ctx, { bookingId: request.bookingId });
    expect(accepted.status).toBe('confirmed');
    expect(await pool(legA!, std)).toMatchObject({ booked: 1 });
    expect(await pool(legB!, std)).toMatchObject({ booked: 1 });
    const events = await owner().query(
      `select type from vs.event where resource_id = $1 order by seq`,
      [request.bookingId],
    );
    expect(events.rows.map((e) => e.type)).toEqual(['request.decided', 'booking.confirmed']);
    expect(await codeOf(acceptRequest(w.db, w.ctx, { bookingId: request.bookingId }))).toBe(
      'INVALID_STATE',
    );
  });

  it('prepaid request → accept: held on a payment hold', async () => {
    const sailing = await w.sailing('ASW-3', 18);
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      quoteId: await w.quote(w.channels.backOffice, sailing, [{ cat: 'JS' }]),
    });
    const accepted = await acceptRequest(w.db, w.ctx, { bookingId: request.bookingId });
    expect(accepted.status).toBe('held');
    const [leg] = await legsOf(sailing);
    expect(await pool(leg!, w.demo.categories.JS)).toMatchObject({ held: 1, booked: 0 });
    const hold = await owner().query(`select kind, status from vs.hold where booking_id = $1`, [
      request.bookingId,
    ]);
    expect(hold.rows).toEqual([{ kind: 'payment', status: 'active' }]);
  });

  it('a request accepted after the cabins sold out fails and changes nothing', async () => {
    const sailing = await w.sailing('LXR-4', 21);
    const [leg] = await legsOf(sailing);
    const rs = w.demo.categories.RS;
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, sailing, [{ cat: 'RS' }]),
    });
    const soldOut = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'RS' }, { cat: 'RS' }]),
      kind: 'option',
    });
    const before = await counters(leg!, rs);
    expect(await codeOf(acceptRequest(w.db, w.ctx, { bookingId: request.bookingId }))).toBe(
      'NOT_AVAILABLE',
    );
    expect(await statusOf(request.bookingId)).toBe('requested');
    expect(await counters(leg!, rs)).toEqual(before);
    await releaseHold(w.db, w.ctx, { holdId: soldOut.holdId });
  });

  it('decline, and timeout after SLA + grace', async () => {
    const sailing = await w.sailing('LXR-4', 28);
    const declined = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, sailing, [{ cat: 'STD' }]),
    });
    await declineRequest(w.db, w.ctx, { bookingId: declined.bookingId, reason: 'Full for groups' });
    expect(await statusOf(declined.bookingId)).toBe('declined');
    expect(await codeOf(acceptRequest(w.db, w.ctx, { bookingId: declined.bookingId }))).toBe(
      'INVALID_STATE',
    );

    const late = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, sailing, [{ cat: 'STD' }]),
    });
    await owner().query(
      `update vs.booking set request_expires_at = now() - interval '1 second' where id = $1`,
      [late.bookingId],
    );
    expect(await codeOf(acceptRequest(w.db, w.ctx, { bookingId: late.bookingId }))).toBe(
      'INVALID_STATE',
    );
    expect((await expireRequests(w.db, w.ctx)).expired).toBeGreaterThanOrEqual(1);
    expect(await statusOf(late.bookingId)).toBe('expired');
  });

  it('offer an alternative with its own hold; accepting moves and confirms the booking', async () => {
    const wanted = await w.sailing('LXR-4', 35);
    const alternative = await w.sailing('LXR-4', 42);
    const [altLeg] = await legsOf(alternative);
    const sup = w.demo.categories.SUP;
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, wanted, [{ cat: 'STD' }]),
      guests: lead,
    });
    const offer = await offerAlternative(w.db, w.ctx, {
      bookingId: request.bookingId,
      quoteId: await w.quote(w.agents.onRequest, alternative, [{ cat: 'SUP' }]),
    });
    expect(await statusOf(request.bookingId)).toBe('offered');
    expect(await pool(altLeg!, sup)).toMatchObject({ held: 1 });
    const { rows } = await owner().query<{ hours: number }>(
      `select round(extract(epoch from expires_at - now()) / 3600)::int as hours from vs.offer where id = $1`,
      [offer.offerId],
    );
    expect(rows[0]!.hours).toBe(48);

    const accepted = await acceptOffer(w.db, w.ctx, { offerId: offer.offerId });
    expect(accepted.status).toBe('confirmed');
    expect(await pool(altLeg!, sup)).toMatchObject({ held: 0, booked: 1 });
    const booking = await owner().query(
      `select sailing_id, revision from vs.booking where id = $1`,
      [request.bookingId],
    );
    expect(booking.rows[0]).toEqual({ sailing_id: alternative, revision: 1 });
    const guests = await owner().query(
      `select c.status from vs.guest g join vs.booking_cabin c on c.id = g.booking_cabin_id where g.booking_id = $1`,
      [request.bookingId],
    );
    expect(guests.rows).toEqual([{ status: 'active' }]); // the lead guest moved to the new cabin
    expect(await codeOf(acceptOffer(w.db, w.ctx, { offerId: offer.offerId }))).toBe('HOLD_EXPIRED');
  });

  it('an offer expires with its hold: the request expires and the cabins return', async () => {
    const alternative = await w.sailing('ASW-3', 46);
    const [leg] = await legsOf(alternative);
    const before = await counters(leg!, w.demo.categories.STD);
    const request = await createRequest(w.db, w.ctx, {
      channelId: w.agents.onRequest,
      quoteId: await w.quote(w.agents.onRequest, await w.sailing('ASW-3', 39), [{ cat: 'STD' }]),
    });
    const offer = await offerAlternative(w.db, w.ctx, {
      bookingId: request.bookingId,
      quoteId: await w.quote(w.agents.onRequest, alternative, [{ cat: 'STD' }]),
    });
    await expireNow('hold', offer.holdId);
    await expireHolds(w.db, w.ctx);
    expect(await statusOf(request.bookingId)).toBe('expired');
    const status = await owner().query(`select status from vs.offer where id = $1`, [
      offer.offerId,
    ]);
    expect(status.rows[0].status).toBe('expired');
    expect(await counters(leg!, w.demo.categories.STD)).toEqual(before);
    expect(await codeOf(acceptOffer(w.db, w.ctx, { offerId: offer.offerId }))).toBe('HOLD_EXPIRED');
  });
});
