import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  confirmHold,
  confirmPaymentHold,
  createHold,
  expireHolds,
  releaseHold,
  upsertGuests,
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

describe('holds and confirmation', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('checkout hold → confirm: held then booked on every leg, one line per cabin per leg', async () => {
    const sailing = await w.sailing('LXR-7', 7);
    const [legA, legB] = await legsOf(sailing);
    const std = w.demo.categories.STD;
    const quoteId = await w.quote(w.channels.nilecrz, sailing, [
      { cat: 'STD' },
      { cat: 'STD', adults: 1 },
    ]);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId,
      kind: 'checkout',
    });
    expect(hold.lines.map((l) => [l.legId, l.n])).toEqual([
      [legA, 2],
      [legB, 2],
    ]);
    const { rows: ttl } = await owner().query<{ minutes: number }>(
      `select round(extract(epoch from expires_at - created_at) / 60)::int as minutes from vs.hold where id = $1`,
      [hold.holdId],
    );
    expect(ttl[0]!.minutes).toBe(30); // contract checkout TTL
    expect((await counters(legA!, std)).find((c) => c.kind === 'pool')).toMatchObject({
      total: 12,
      held: 2,
      booked: 0,
    });

    const booking = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    expect(booking.status).toBe('confirmed');
    expect(booking.ref).toMatch(/^VS-\d{2}-\d{5,}$/);
    expect((await counters(legA!, std)).find((c) => c.kind === 'pool')).toMatchObject({
      held: 0,
      booked: 2,
    });
    expect((await counters(legB!, std)).find((c) => c.kind === 'pool')).toMatchObject({
      held: 0,
      booked: 2,
    });
    const lines = await owner().query(
      `select leg_id from vs.booking_line where booking_id = $1 and status = 'confirmed'`,
      [booking.bookingId],
    );
    expect(lines.rowCount).toBe(4);
    const { rows } = await owner().query(`select status, revision from vs.booking where id = $1`, [
      booking.bookingId,
    ]);
    expect(rows[0]).toEqual({ status: 'confirmed', revision: 1 });
    const revision = await owner().query(
      `select rev, reason from vs.booking_revision where booking_id = $1`,
      [booking.bookingId],
    );
    expect(revision.rows).toEqual([{ rev: 1, reason: 'confirmed' }]);
    const event = await owner().query(
      `select payload from vs.event where resource_id = $1 and type = 'booking.confirmed'`,
      [booking.bookingId],
    );
    expect(event.rows[0].payload).toMatchObject({ ref: booking.ref, status: 'confirmed' });
    expect(await codeOf(confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead }))).toBe(
      'HOLD_NOT_ACTIVE',
    );
  });

  it('option hold lasts the contract option TTL (72 h)', async () => {
    const quoteId = await w.quote(w.channels.nilecrz, await w.sailing('ASW-3', 11), [
      { cat: 'SUP' },
    ]);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId,
      kind: 'option',
    });
    const { rows } = await owner().query<{ hours: number }>(
      `select round(extract(epoch from expires_at - created_at) / 3600)::int as hours from vs.hold where id = $1`,
      [hold.holdId],
    );
    expect(rows[0]!.hours).toBe(72);
    await releaseHold(w.db, w.ctx, { holdId: hold.holdId });
  });

  it('release returns the cabins once', async () => {
    const sailing = await w.sailing('LXR-4', 14);
    const [leg] = await legsOf(sailing);
    const before = await counters(leg!, w.demo.categories.JS);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'JS' }]),
      kind: 'checkout',
    });
    await releaseHold(w.db, w.ctx, { holdId: hold.holdId });
    expect(await counters(leg!, w.demo.categories.JS)).toEqual(before);
    expect(await codeOf(releaseHold(w.db, w.ctx, { holdId: hold.holdId }))).toBe('HOLD_NOT_ACTIVE');
  });

  it('confirm after expiry is refused; the expiry job returns the cabins', async () => {
    const sailing = await w.sailing('LXR-4', 21);
    const [leg] = await legsOf(sailing);
    const before = await counters(leg!, w.demo.categories.STD);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'checkout',
    });
    await expireNow('hold', hold.holdId);
    expect(await codeOf(confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead }))).toBe(
      'HOLD_EXPIRED',
    );
    const { expired } = await expireHolds(w.db, w.ctx);
    expect(expired).toBeGreaterThanOrEqual(1);
    expect(await counters(leg!, w.demo.categories.STD)).toEqual(before);
    const { rows } = await owner().query(`select status from vs.hold where id = $1`, [hold.holdId]);
    expect(rows[0].status).toBe('expired');
    expect(await codeOf(confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead }))).toBe(
      'HOLD_EXPIRED',
    );
  });

  it('refuses an expired quote, a stopped or on-request contract, and a full sailing', async () => {
    const sailing = await w.sailing('LXR-4', 28);
    const expiredQuote = await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]);
    await owner().query(
      `update vs.quote set expires_at = now() - interval '1 second' where id = $1`,
      [expiredQuote],
    );
    expect(
      await codeOf(
        createHold(w.db, w.ctx, {
          channelId: w.channels.nilecrz,
          quoteId: expiredQuote,
          kind: 'checkout',
        }),
      ),
    ).toBe('QUOTE_EXPIRED');

    const onRequest = await w.quote(w.agents.onRequest, sailing, [{ cat: 'STD' }]);
    expect(
      await codeOf(
        createHold(w.db, w.ctx, {
          channelId: w.agents.onRequest,
          quoteId: onRequest,
          kind: 'option',
        }),
      ),
    ).toBe('CONTRACT_FORBIDS');
    expect(await codeOf(w.quote(w.agents.stopped, sailing, [{ cat: 'STD' }]))).toBe(
      'CONTRACT_FORBIDS',
    );

    const otherChannel = await w.quote(w.agents.credit, sailing, [{ cat: 'STD' }]);
    expect(
      await codeOf(
        createHold(w.db, w.ctx, {
          channelId: w.channels.nilecrz,
          quoteId: otherChannel,
          kind: 'checkout',
        }),
      ),
    ).toBe('CONTRACT_FORBIDS');

    const both = await w.quote(w.channels.nilecrz, sailing, [{ cat: 'RS' }, { cat: 'RS' }]);
    const taken = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: both,
      kind: 'option',
    });
    const one = await w.quote(w.channels.nilecrz, sailing, [{ cat: 'RS' }]);
    expect(
      await codeOf(
        createHold(w.db, w.ctx, { channelId: w.channels.nilecrz, quoteId: one, kind: 'checkout' }),
      ),
    ).toBe('NOT_AVAILABLE');
    await releaseHold(w.db, w.ctx, { holdId: taken.holdId });
  });

  it('a repeated request key returns the first result; a different body with the same key is refused', async () => {
    const quoteId = await w.quote(w.channels.nilecrz, await w.sailing('ASW-3', 25), [
      { cat: 'STD' },
    ]);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId,
      kind: 'option',
      requestKey: 'click-1',
    });
    const again = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId,
      kind: 'option',
      requestKey: 'click-1',
    });
    expect(again).toEqual(hold);
    const holds = await owner().query(`select 1 from vs.hold where quote_id = $1`, [quoteId]);
    expect(holds.rowCount).toBe(1);

    const first = await confirmHold(w.db, w.ctx, {
      holdId: hold.holdId,
      guests: lead,
      requestKey: 'click-2',
    });
    const twice = await confirmHold(w.db, w.ctx, {
      holdId: hold.holdId,
      guests: lead,
      requestKey: 'click-2',
    });
    expect(twice).toEqual(first);
    expect(
      await codeOf(
        createHold(w.db, w.ctx, {
          channelId: w.channels.nilecrz,
          quoteId,
          kind: 'checkout',
          requestKey: 'click-1',
        }),
      ),
    ).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a repeated channel_ref returns the existing booking and leaves the new hold alone', async () => {
    const sailing = await w.sailing('ASW-3', 32);
    const first = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'checkout',
    });
    const booking = await confirmHold(w.db, w.ctx, {
      holdId: first.holdId,
      guests: lead,
      channelRef: 'NC-1001',
    });
    const second = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD' }]),
      kind: 'checkout',
    });
    const repeat = await confirmHold(w.db, w.ctx, {
      holdId: second.holdId,
      guests: lead,
      channelRef: 'NC-1001',
    });
    expect(repeat).toMatchObject({ bookingId: booking.bookingId, existing: true });
    const { rows } = await owner().query(`select status from vs.hold where id = $1`, [
      second.holdId,
    ]);
    expect(rows[0].status).toBe('active');
    await releaseHold(w.db, w.ctx, { holdId: second.holdId });
  });

  it("prepaid: the payment hold follows the company's Unpaid booking held setting", async () => {
    const sailing = await w.sailing('LXR-4', 42);
    await owner().query(
      `update vs.operator_setting set payment_hold_hours = 36 where operator_id = $1`,
      [w.ctx.operatorId],
    );
    try {
      const hold = await createHold(w.db, w.ctx, {
        channelId: w.channels.backOffice,
        quoteId: await w.quote(w.channels.backOffice, sailing, [{ cat: 'SUP' }]),
        kind: 'option',
      });
      await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
      const { rows } = await owner().query<{ hours: number }>(
        `select round(extract(epoch from expires_at - now()) / 3600)::int as hours from vs.hold where id = $1`,
        [hold.holdId],
      );
      expect(rows[0]!.hours).toBe(36);
    } finally {
      await owner().query(
        `update vs.operator_setting set payment_hold_hours = 24 where operator_id = $1`,
        [w.ctx.operatorId],
      );
    }
  });

  it('prepaid: confirm keeps the cabins on a 24 h payment hold; payment confirms; expiry releases', async () => {
    const sailing = await w.sailing('LXR-4', 35);
    const [leg] = await legsOf(sailing);
    const sup = w.demo.categories.SUP;
    const before = await counters(leg!, sup);

    const paid = await createHold(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      quoteId: await w.quote(w.channels.backOffice, sailing, [{ cat: 'SUP' }]),
      kind: 'option',
    });
    const held = await confirmHold(w.db, w.ctx, { holdId: paid.holdId, guests: lead });
    expect(held.status).toBe('held');
    const { rows } = await owner().query<{ kind: string; hours: number }>(
      `select kind, round(extract(epoch from expires_at - now()) / 3600)::int as hours from vs.hold where id = $1`,
      [paid.holdId],
    );
    expect(rows[0]).toEqual({ kind: 'payment', hours: 24 });
    expect((await counters(leg!, sup)).find((c) => c.kind === 'pool')).toMatchObject({
      held: 1,
      booked: 0,
    });
    const confirmed = await confirmPaymentHold(w.db, w.ctx, { bookingId: held.bookingId });
    expect(confirmed.status).toBe('confirmed');
    expect((await counters(leg!, sup)).find((c) => c.kind === 'pool')).toMatchObject({
      held: 0,
      booked: 1,
    });

    const lapsed = await createHold(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      quoteId: await w.quote(w.channels.backOffice, sailing, [{ cat: 'SUP' }]),
      kind: 'option',
    });
    const unpaid = await confirmHold(w.db, w.ctx, { holdId: lapsed.holdId, guests: lead });
    await expireNow('hold', lapsed.holdId);
    await expireHolds(w.db, w.ctx);
    const status = await owner().query(`select status from vs.booking where id = $1`, [
      unpaid.bookingId,
    ]);
    expect(status.rows[0].status).toBe('expired');
    expect((await counters(leg!, sup)).find((c) => c.kind === 'pool')).toMatchObject({
      held: 0,
      booked: before.find((c) => c.kind === 'pool')!.booked + 1,
    });
    expect(await codeOf(confirmPaymentHold(w.db, w.ctx, { bookingId: unpaid.bookingId }))).toBe(
      'HOLD_NOT_ACTIVE',
    );
  });

  it('stores passport numbers encrypted, keeps them out of the audit log, and flags age mismatches', async () => {
    const sailing = await w.sailing('LXR-4', 42);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'STD', ages: [7] }]),
      kind: 'checkout',
    });
    const booking = await confirmHold(w.db, w.ctx, {
      holdId: hold.holdId,
      guests: [
        {
          cabin: 0,
          firstName: 'Omar',
          lastName: 'Saleh',
          nationality: 'EG',
          passportNumber: 'A98765432',
          lead: true,
        },
        {
          cabin: 0,
          firstName: 'Laila',
          lastName: 'Saleh',
          dateOfBirth: '2024-01-01',
          passportNumber: 'A11223344',
        },
      ],
    });
    const guests = await owner().query(
      `select passport_ciphertext, passport_key_id from vs.guest where booking_id = $1`,
      [booking.bookingId],
    );
    for (const g of guests.rows) {
      expect(g.passport_key_id).toBe('local1');
      expect(Buffer.from(g.passport_ciphertext).toString('latin1')).not.toMatch(
        /A98765432|A11223344/,
      );
    }
    const audit = await owner().query(
      `select diff::text from vs.audit_log where operator_id = $1`,
      [w.ctx.operatorId],
    );
    expect(audit.rows.map((r) => r.diff).join('\n')).not.toMatch(/A98765432|A11223344/);
    // Quoted as a 7-year-old; the date of birth makes her 2 → flagged, not repriced.
    const flagged = await owner().query(
      `select details from vs.exception where kind = 'guest_age_mismatch' and refs @> $1::jsonb`,
      [JSON.stringify([{ entity: 'booking', id: booking.bookingId }])],
    );
    expect(flagged.rows[0].details.mismatches[0]).toMatchObject({ quoted: [7], actual: [2] });
  });

  it('guest details close at the manifest cut-off (7 days before embarkation)', async () => {
    const soon = await w.sailing('LXR-4', 0); // embarks within 7 days
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, soon, [{ cat: 'STD' }]),
      kind: 'checkout',
    });
    const booking = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    expect(
      await codeOf(upsertGuests(w.db, w.ctx, { bookingId: booking.bookingId, guests: lead })),
    ).toBe('INVALID_STATE');

    const later = await w.sailing('LXR-4', 49);
    const hold2 = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, later, [{ cat: 'STD' }]),
      kind: 'checkout',
    });
    const booking2 = await confirmHold(w.db, w.ctx, { holdId: hold2.holdId, guests: lead });
    await upsertGuests(w.db, w.ctx, {
      bookingId: booking2.bookingId,
      guests: [...lead, { cabin: 0, firstName: 'Karim', lastName: 'Hassan' }],
    });
    const count = await owner().query(`select 1 from vs.guest where booking_id = $1`, [
      booking2.bookingId,
    ]);
    expect(count.rowCount).toBe(2);
  });
});
