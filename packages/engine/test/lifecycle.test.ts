import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  applyAmendment,
  applyScheduleException,
  calculateRefund,
  completeBookings,
  confirmHold,
  createChannel,
  createContract,
  createHold,
  createQuote,
  expireHolds,
  getActionList,
  quoteAmendment,
  recordPayment,
  recordRefund,
  releaseHold,
  todayInCairo,
} from '../src/index';
import {
  bookingWorld,
  cancelSailing,
  counters,
  expireNow,
  lead,
  legsOf,
  type BookingWorld,
} from './helpers/booking-world';
import { legs, sailingOverLeg } from './helpers/world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );
const booking = async (id: string) =>
  (
    await owner().query<{
      status: string;
      payment_status: string;
      revision: number;
      amount_paid: string;
      balance_due_date: BusinessDate;
    }>(
      `select status, payment_status, revision, amount_paid::text, balance_due_date::text from vs.booking where id = $1`,
      [id],
    )
  ).rows[0]!;

/** Gaps found by the review of 14 November 2026 (docs/decisions.md, "Review fixes, batch 1"). */
describe('booking lifecycle', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  const confirmOn = async (
    channelId: string,
    sailing: string,
    cabins: { cat: 'STD' | 'SUP' }[] = [{ cat: 'STD' }],
  ) => {
    const hold = await createHold(w.db, w.ctx, {
      channelId,
      quoteId: await w.quote(channelId, sailing, cabins),
      kind: 'option',
    });
    return {
      sailing,
      holdId: hold.holdId,
      ...(await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead })),
    };
  };
  const twoCabins = (bookingId: string) =>
    quoteAmendment(w.db, w.ctx, {
      bookingId,
      cabins: [w.demo.categories.STD, w.demo.categories.STD].map((categoryId) => ({
        categoryId,
        adults: 2,
        childAges: [],
      })),
    });

  it('a sailing that has departed cannot be quoted, held or confirmed; the boarding day still sells', async () => {
    const sailing = await w.sailing('LXR-4', 14);
    const nilecrz = w.channels.nilecrz;
    const held = await createHold(w.db, w.ctx, {
      channelId: nilecrz,
      quoteId: await w.quote(nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'option',
    });
    const spare = await w.quote(nilecrz, sailing, [{ cat: 'STD' }]);
    const today = await todayInCairo(w.db);
    // Test-only time travel: the sailing boards today.
    await owner().query(`update vs.sailing set embark_date = $2::date where id = $1`, [
      sailing,
      today,
    ]);
    const onTheDay = await createHold(w.db, w.ctx, {
      channelId: nilecrz,
      quoteId: spare,
      kind: 'checkout',
    });
    await releaseHold(w.db, w.ctx, { holdId: onTheDay.holdId });
    // It left yesterday.
    await owner().query(`update vs.sailing set embark_date = $2::date - 1 where id = $1`, [
      sailing,
      today,
    ]);
    const quoteNow = createQuote(w.db, w.ctx, {
      channelId: nilecrz,
      sailingId: sailing,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2, childAges: [] }],
    });
    expect(await codeOf(quoteNow)).toBe('SAILING_CLOSED');
    expect(
      await codeOf(createHold(w.db, w.ctx, { channelId: nilecrz, quoteId: spare, kind: 'option' })),
    ).toBe('SAILING_CLOSED');
    expect(await codeOf(confirmHold(w.db, w.ctx, { holdId: held.holdId, guests: lead }))).toBe(
      'SAILING_CLOSED',
    );
    await releaseHold(w.db, w.ctx, { holdId: held.holdId });
  });

  it('a booking cannot be amended onto a sailing that has departed', async () => {
    const b = await confirmOn(w.channels.nilecrz, await w.sailing('LXR-4', 21));
    const gone = await w.sailing('LXR-4', 28);
    const quoted = await quoteAmendment(w.db, w.ctx, { bookingId: b.bookingId, sailingId: gone });
    await owner().query(`update vs.sailing set embark_date = $2::date - 2 where id = $1`, [
      gone,
      await todayInCairo(w.db),
    ]);
    expect(
      await codeOf(
        applyAmendment(w.db, w.ctx, {
          bookingId: b.bookingId,
          revision: 1,
          amendmentQuoteId: quoted.quote.id,
        }),
      ),
    ).toBe('SAILING_CLOSED');
    expect(await booking(b.bookingId)).toMatchObject({ status: 'confirmed', revision: 1 });
  });

  it('on credit, an amendment that adds more than the limit leaves is refused; a warn-only contract lets it through', async () => {
    const agent = await createChannel(w.db, w.ctx, {
      code: 'tight-amender',
      name: 'Tight Amender',
      type: 'agent',
      creditAllowed: true,
      creditLimit: 200_000,
      creditCurrency: 'USD',
    });
    await createContract(w.db, w.ctx, {
      channelId: agent.id,
      vesselId: w.demo.vesselId,
      allocation: 'pool',
      paymentMode: 'credit',
      validFrom: w.M,
      categoryIds: Object.values(w.demo.categories),
      ratePlanIds: w.ratePlanIds,
    });
    const sailing = await w.sailing('LXR-4', 35);
    const [leg] = await legsOf(sailing);
    // One standard cabin (about 1,170 USD) fits a 2,000 USD limit; a second does not.
    const b = await confirmOn(agent.id, sailing);
    expect(b.status).toBe('confirmed');
    const before = (await counters(leg!, w.demo.categories.STD)).find((c) => c.kind === 'pool')!;
    const quoted = await twoCabins(b.bookingId);
    const apply = () =>
      applyAmendment(w.db, w.ctx, {
        bookingId: b.bookingId,
        revision: 1,
        amendmentQuoteId: quoted.quote.id,
      });
    const refused = await apply().catch((e: unknown) => e);
    expect(isDomainError(refused, 'CONTRACT_FORBIDS') && refused.details).toMatchObject({
      reason: 'credit_limit',
    });
    // Nothing changed: same revision, same cabins sold.
    expect(await booking(b.bookingId)).toMatchObject({ status: 'confirmed', revision: 1 });
    expect(
      (await counters(leg!, w.demo.categories.STD)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ booked: before.booked });

    await owner().query(
      `update vs.channel_contract set credit_limit_mode = 'warn' where channel_id = $1`,
      [agent.id],
    );
    expect((await apply()).revision).toBe(2);
  });

  it('an amendment that takes more cabins is refused while the contract has stopped selling', async () => {
    const b = await confirmOn(w.agents.credit, await w.sailing('LXR-4', 42));
    const quoted = await twoCabins(b.bookingId);
    await owner().query(`update vs.channel_contract set stop_sell = true where channel_id = $1`, [
      w.agents.credit,
    ]);
    try {
      expect(
        await codeOf(
          applyAmendment(w.db, w.ctx, {
            bookingId: b.bookingId,
            revision: 1,
            amendmentQuoteId: quoted.quote.id,
          }),
        ),
      ).toBe('CONTRACT_FORBIDS');
    } finally {
      await owner().query(
        `update vs.channel_contract set stop_sell = false where channel_id = $1`,
        [w.agents.credit],
      );
    }
  });

  it('shifting a sailing moves the balance due date of its bookings with it', async () => {
    // The last leg of the schedule has room after it.
    const last = (await legs(w.demo.vesselId)).at(-1)!;
    const b = await confirmOn(w.channels.backOffice, await sailingOverLeg(last.id));
    const before = await booking(b.bookingId);
    expect(before.status).toBe('held');
    await applyScheduleException(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      kind: 'shift',
      legIds: [last.id],
      days: 2,
      reason: 'Low water at Esna',
    });
    expect((await booking(b.bookingId)).balance_due_date).toBe(addDays(before.balance_due_date, 2));
  });

  it('a booking left on a cancelled sailing is not completed when its dates pass', async () => {
    const b = await confirmOn(w.agents.credit, await w.sailing('LXR-4', 49));
    await cancelSailing(w, b.sailing);
    await owner().query(
      `update vs.sailing set embark_date = $2::date - 5, disembark_date = $2::date - 1 where id = $1`,
      [b.sailing, await todayInCairo(w.db)],
    );
    await completeBookings(w.db, w.ctx);
    expect((await booking(b.bookingId)).status).toBe('confirmed');
  });

  it('money received below the deposit on a booking that then expired can be refunded', async () => {
    const b = await confirmOn(w.channels.backOffice, await w.sailing('LXR-4', 56));
    expect(b.status).toBe('held');
    await recordPayment(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'cash',
      amount: 10_000n,
      currency: 'USD',
      reference: 'part of the deposit',
      receivedOn: '2026-11-14',
    });
    expect((await booking(b.bookingId)).status).toBe('held');
    await expireNow('hold', b.holdId);
    await expireHolds(w.db, w.ctx);
    expect(await booking(b.bookingId)).toMatchObject({
      status: 'expired',
      payment_status: 'refund_due',
    });
    const list = await getActionList(w.db, w.ctx);
    expect(list.paidUnavailable.map((x) => x.bookingId)).toContain(b.bookingId);
    expect((await calculateRefund(w.db, w.ctx, { bookingId: b.bookingId })).refundable).toBe(
      10_000n,
    );
    await recordRefund(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'cash',
      amount: 10_000n,
      currency: 'USD',
      reference: 'deposit returned',
      refundedOn: '2026-11-14',
    });
    expect(await booking(b.bookingId)).toMatchObject({
      status: 'expired',
      payment_status: 'refunded',
      amount_paid: '0',
    });
    expect(
      (await getActionList(w.db, w.ctx)).paidUnavailable.map((x) => x.bookingId),
    ).not.toContain(b.bookingId);
  });
});
