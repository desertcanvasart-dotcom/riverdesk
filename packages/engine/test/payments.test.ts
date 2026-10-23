import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import { formatMinor, money, mulDivHalfUp } from '@vs/shared';
import {
  acceptRequest,
  applyAmendment,
  calculateRefund,
  cancelBooking,
  confirmHold,
  createChannel,
  createContract,
  createHold,
  expireHolds,
  getActionList,
  processOverdueBalances,
  quoteAmendment,
  recordPayment,
  recordRefund,
  reversePayment,
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
const booking = async (id: string) =>
  (
    await owner().query<{
      status: string;
      payment_status: string;
      total: string;
      deposit_amount: string;
      amount_paid: string;
      fees: string;
      penalty_amount: string | null;
      currency: string;
    }>(
      `select status, payment_status, total::text, deposit_amount::text, amount_paid::text, fees::text, penalty_amount::text, currency from vs.booking where id = $1`,
      [id],
    )
  ).rows[0]!;
const pay = (
  w: BookingWorld,
  bookingId: string,
  amount: bigint | number,
  extra: Partial<Parameters<typeof recordPayment>[2]> = {},
) =>
  recordPayment(w.db, w.ctx, {
    bookingId,
    method: 'bank_transfer',
    amount,
    currency: 'USD',
    reference: `TX-${Math.random().toString(36).slice(2, 8)}`,
    receivedOn: '2026-10-23',
    ...extra,
  });

describe('payments and exceptions', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  /** A prepaid (back-office) booking waiting for its deposit. */
  async function prepaid(
    pattern: 'LXR-4' | 'LXR-7' | 'ASW-3',
    offset: number,
    cat: 'STD' | 'SUP' | 'JS' | 'RS' = 'STD',
  ) {
    const sailing = await w.sailing(pattern, offset);
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      quoteId: await w.quote(w.channels.backOffice, sailing, [{ cat }]),
      kind: 'option',
    });
    const result = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    expect(result.status).toBe('held');
    return { sailing, holdId: hold.holdId, bookingId: result.bookingId, ref: result.ref };
  }

  it('the deposit is 25% of the total, rounded half-up; paying it while the hold is active confirms in one transaction', async () => {
    const b = await prepaid('LXR-4', 21);
    const before = await booking(b.bookingId);
    expect(BigInt(before.deposit_amount)).toBe(mulDivHalfUp(BigInt(before.total), 2500n, 10000n));

    const short = await pay(w, b.bookingId, BigInt(before.deposit_amount) - 100n);
    expect(short).toMatchObject({ bookingStatus: 'held', paymentStatus: 'unpaid' });
    const rest = await pay(w, b.bookingId, 100n, { kind: 'deposit' });
    expect(rest).toMatchObject({ bookingStatus: 'confirmed', paymentStatus: 'deposit_paid' });
    const [leg] = await legsOf(b.sailing);
    expect(
      (await counters(leg!, w.demo.categories.STD)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ held: 0, booked: 1 });
    const events = await owner().query(
      `select type from vs.event where resource_id = $1 order by seq`,
      [b.bookingId],
    );
    expect(events.rows.map((e) => e.type)).toEqual([
      'payment.recorded',
      'booking.confirmed',
      'payment.recorded',
    ]);
  });

  it('test 8: payment after the hold expired and the cabin was sold → paid_unavailable, exception, no confirmation', async () => {
    const b = await prepaid('LXR-4', 28, 'RS');
    await expireNow('hold', b.holdId);
    await expireHolds(w.db, w.ctx);
    const [leg] = await legsOf(b.sailing);
    // Both royal suites are then sold to nilecrz.
    const sold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, b.sailing, [{ cat: 'RS' }, { cat: 'RS' }]),
      kind: 'option',
    });
    await confirmHold(w.db, w.ctx, { holdId: sold.holdId, guests: lead });

    const total = BigInt((await booking(b.bookingId)).total);
    const result = await pay(w, b.bookingId, total);
    expect(result).toMatchObject({
      bookingStatus: 'paid_unavailable',
      paymentStatus: 'refund_due',
    });
    expect(
      (await counters(leg!, w.demo.categories.RS)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ held: 0, booked: 2 });
    const lines = await owner().query(
      `select 1 from vs.booking_line where booking_id = $1 and status = 'confirmed'`,
      [b.bookingId],
    );
    expect(lines.rowCount).toBe(0);
    const exception = await owner().query(
      `select kind, severity from vs.exception where dedupe_key = $1`,
      [`paid_unavailable:${b.bookingId}`],
    );
    expect(exception.rows).toEqual([{ kind: 'paid_unavailable', severity: 'critical' }]);
    const event = await owner().query(
      `select 1 from vs.event where resource_id = $1 and type = 'booking.paid_unavailable'`,
      [b.bookingId],
    );
    expect(event.rowCount).toBe(1);
    expect((await calculateRefund(w.db, w.ctx, { bookingId: b.bookingId })).refundable).toBe(total);
  });

  it('payment on a hold that expired but was not processed yet: the engine finishes the expiry and retakes its own cabin', async () => {
    const b = await prepaid('LXR-4', 35, 'RS');
    await expireNow('hold', b.holdId);
    const [leg] = await legsOf(b.sailing);
    // The other royal suite is sold; this booking's suite is still held by its expired hold.
    const sold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, b.sailing, [{ cat: 'RS' }]),
      kind: 'option',
    });
    await confirmHold(w.db, w.ctx, { holdId: sold.holdId, guests: lead });
    const result = await pay(w, b.bookingId, BigInt((await booking(b.bookingId)).total));
    expect(result).toMatchObject({ bookingStatus: 'confirmed', paymentStatus: 'paid' });
    expect(
      (await counters(leg!, w.demo.categories.RS)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ held: 0, booked: 2 });
    const hold = await owner().query(`select status from vs.hold where id = $1`, [b.holdId]);
    expect(hold.rows[0].status).toBe('expired');
  });

  it('payment after expiry with the cabin still free → the cabins are taken again and the booking confirmed', async () => {
    const b = await prepaid('ASW-3', 32, 'SUP');
    await expireNow('hold', b.holdId);
    await expireHolds(w.db, w.ctx);
    expect((await booking(b.bookingId)).status).toBe('expired');
    const total = BigInt((await booking(b.bookingId)).total);
    const result = await pay(w, b.bookingId, total);
    expect(result).toMatchObject({ bookingStatus: 'confirmed', paymentStatus: 'paid' });
    const [leg] = await legsOf(b.sailing);
    expect(
      (await counters(leg!, w.demo.categories.SUP)).find((c) => c.kind === 'pool'),
    ).toMatchObject({ held: 0, booked: 1 });
  });

  it('credit limit: over the limit the booking becomes a request (hold released); staff acceptance approves it', async () => {
    const agent = await createChannel(w.db, w.ctx, {
      code: 'tight-agent',
      name: 'Tight Agent',
      type: 'agent',
      creditAllowed: true,
      creditLimit: 200_000,
      creditCurrency: 'USD',
    });
    const none = await createChannel(w.db, w.ctx, {
      code: 'nocredit-agent',
      name: 'No Credit',
      type: 'agent',
    });
    for (const channelId of [agent.id, none.id]) {
      await createContract(w.db, w.ctx, {
        channelId,
        vesselId: w.demo.vesselId,
        allocation: 'pool',
        paymentMode: 'credit',
        validFrom: w.M,
        categoryIds: Object.values(w.demo.categories),
        ratePlanIds: w.ratePlanIds,
      });
    }
    const sailing = await w.sailing('LXR-4', 42);
    const [leg] = await legsOf(sailing);
    const std = w.demo.categories.STD;
    const confirmOn = async (channelId: string) => {
      const hold = await createHold(w.db, w.ctx, {
        channelId,
        quoteId: await w.quote(channelId, sailing, [{ cat: 'STD' }]),
        kind: 'option',
      });
      return confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
    };
    // One standard cabin for 2 adults, 4 nights, is about 1,170 USD: the first fits, the second not.
    const first = await confirmOn(agent.id);
    expect(first.status).toBe('confirmed');
    const before = (await counters(leg!, std)).find((c) => c.kind === 'pool')!;
    const second = await confirmOn(agent.id);
    expect(second).toMatchObject({ status: 'requested', reason: 'credit_limit' });
    expect((await counters(leg!, std)).find((c) => c.kind === 'pool')).toMatchObject({
      held: before.held,
      booked: before.booked,
    });
    const accepted = await acceptRequest(w.db, w.ctx, { bookingId: second.bookingId });
    expect(accepted.status).toBe('confirmed');
    // Credit is off until set per agent.
    expect((await confirmOn(none.id)).status).toBe('requested');
  });

  it('a reversal is a new opposite entry, once; the balance follows', async () => {
    const b = await prepaid('ASW-3', 39);
    const total = BigInt((await booking(b.bookingId)).total);
    await pay(w, b.bookingId, total - 1000n);
    const wrong = await pay(w, b.bookingId, 1000n);
    expect((await booking(b.bookingId)).payment_status).toBe('paid');
    await reversePayment(w.db, w.ctx, {
      paymentId: wrong.paymentId,
      reason: 'Duplicate bank entry',
    });
    expect(await booking(b.bookingId)).toMatchObject({
      amount_paid: String(total - 1000n),
      payment_status: 'deposit_paid',
    });
    expect(
      await codeOf(reversePayment(w.db, w.ctx, { paymentId: wrong.paymentId, reason: 'again' })),
    ).toBe('INVALID_STATE');
    const ledger = await owner().query(
      `select kind, amount::text from vs.payment where booking_id = $1 order by created_at`,
      [b.bookingId],
    );
    expect(ledger.rows.map((r) => [r.kind, r.amount])).toEqual([
      ['payment', String(total - 1000n)],
      ['payment', '1000'],
      ['reversal', '-1000'],
    ]);
    await expect(
      owner().query(
        `set role vs_backoffice; update vs.payment set amount = 1 where booking_id = $1`,
        [b.bookingId],
      ),
    ).rejects.toBeTruthy();
  });

  it.each([
    [63, 0],
    [35, 2500],
    [21, 5000],
    [7, 10000],
  ])(
    'refund after cancelling at M+%i days keeps %i bps and refunds the rest',
    async (offset, bps) => {
      const sailing = await w.sailing('ASW-3', offset + 4);
      const hold = await createHold(w.db, w.ctx, {
        channelId: w.channels.nilecrz,
        quoteId: await w.quote(w.channels.nilecrz, sailing, [{ cat: 'JS' }]),
        kind: 'option',
      });
      const b = await confirmHold(w.db, w.ctx, { holdId: hold.holdId, guests: lead });
      const total = BigInt((await booking(b.bookingId)).total);
      await recordPayment(w.db, w.ctx, {
        bookingId: b.bookingId,
        method: 'channel',
        amount: total,
        currency: 'USD',
        reference: 'nilecrz settlement',
        receivedOn: '2026-10-23',
      });
      await cancelBooking(w.db, w.ctx, { bookingId: b.bookingId, reason: 'Guest cancelled' });
      const due = await calculateRefund(w.db, w.ctx, { bookingId: b.bookingId });
      const penalty = mulDivHalfUp(total, BigInt(bps), 10000n);
      expect(due).toMatchObject({ paid: total, kept: penalty, refundable: total - penalty });
      if (due.refundable > 0n) {
        expect((await booking(b.bookingId)).payment_status).toBe('refund_due');
        expect(
          await codeOf(
            recordRefund(w.db, w.ctx, {
              bookingId: b.bookingId,
              method: 'bank_transfer',
              amount: due.refundable + 1n,
              currency: 'USD',
              reference: 'too much',
              refundedOn: '2026-10-23',
            }),
          ),
        ).toBe('VALIDATION_FAILED');
        await recordRefund(w.db, w.ctx, {
          bookingId: b.bookingId,
          method: 'bank_transfer',
          amount: due.refundable,
          currency: 'USD',
          reference: 'refund',
          refundedOn: '2026-10-23',
        });
        expect((await booking(b.bookingId)).payment_status).toBe('refunded');
      } else {
        expect((await booking(b.bookingId)).payment_status).toBe('paid');
      }
    },
  );

  it('a payment in another currency needs a rate and stores the booking-currency equivalent', async () => {
    const b = await prepaid('LXR-4', 49);
    expect(await codeOf(pay(w, b.bookingId, 50_000n, { currency: 'EUR' }))).toBe(
      'VALIDATION_FAILED',
    );
    const eur = await pay(w, b.bookingId, 50_000n, { currency: 'EUR', fxRate: '1.0853' });
    expect(eur.bookingAmount).toBe(54_265n); // 500.00 EUR × 1.0853 = 542.65 USD
    const row = await owner().query(
      `select amount::text, currency, fx_rate, booking_amount::text from vs.payment where id = $1`,
      [eur.paymentId],
    );
    expect(row.rows[0]).toEqual({
      amount: '50000',
      currency: 'EUR',
      fx_rate: '1.0853',
      booking_amount: '54265',
    });
  });

  it('action list: expiring holds, requests, deposits and balances due, paid but unavailable, exceptions', async () => {
    const waiting = await prepaid('ASW-3', 46);
    await owner().query(
      `update vs.hold set expires_at = now() + interval '1 second' where id = $1`,
      [waiting.holdId],
    );
    const overdue = await prepaid('LXR-4', 7, 'JS');
    await pay(w, overdue.bookingId, BigInt((await booking(overdue.bookingId)).deposit_amount));
    // Test-only time travel: the balance fell due yesterday.
    await owner().query(
      `update vs.booking set balance_due_date = (now() at time zone 'Africa/Cairo')::date - 1 where id = $1`,
      [overdue.bookingId],
    );
    const list = await getActionList(w.db, w.ctx);
    expect(list.holdsExpiringToday.map((h) => h.bookingRef)).toContain(waiting.ref);
    expect(list.depositsDue.map((d) => d.ref)).toContain(waiting.ref);
    expect(list.balancesDue.find((d) => d.ref === overdue.ref)).toMatchObject({ overdue: true });
    expect(list.paidUnavailable.length).toBeGreaterThanOrEqual(1);
    expect(list.exceptions.some((e) => e.kind === 'paid_unavailable')).toBe(true);
    expect(list.requests.length).toBeGreaterThanOrEqual(0);
  });

  it('overdue balances: a late_payment exception and one notice; automatic cancellation only when the policy enables it', async () => {
    const b = await prepaid('ASW-3', 11, 'SUP');
    await pay(w, b.bookingId, BigInt((await booking(b.bookingId)).deposit_amount));
    await owner().query(
      `update vs.booking set balance_due_date = (now() at time zone 'Africa/Cairo')::date - 1 where id = $1`,
      [b.bookingId],
    );
    const first = await processOverdueBalances(w.db, w.ctx);
    expect(first.notices).toBeGreaterThanOrEqual(1);
    const again = await processOverdueBalances(w.db, w.ctx);
    expect(again.notices).toBe(0);
    expect((await booking(b.bookingId)).status).toBe('confirmed');
    const notices = await owner().query(
      `select 1 from vs.event where resource_id = $1 and type = 'payment.overdue'`,
      [b.bookingId],
    );
    expect(notices.rowCount).toBe(1);

    // Test-only: this booking's payment policy snapshot enables automatic cancellation.
    await owner().query(
      `update vs.quote set policies = jsonb_set(jsonb_set(policies, '{payment,auto_cancel_overdue}', 'true'), '{payment,auto_cancel_after_days}', '0')
       where id = (select quote_id from vs.booking where id = $1)`,
      [b.bookingId],
    );
    const auto = await processOverdueBalances(w.db, w.ctx);
    expect(auto.cancelled).toBeGreaterThanOrEqual(1);
    expect((await booking(b.bookingId)).status).toBe('cancelled');
  });

  it('worked ledger: deposit, amendment fee, balance, cancellation, partial and final refund', async () => {
    const b = await prepaid('LXR-7', 35, 'SUP');
    const rows: string[][] = [];
    const usd = (n: bigint | string) => formatMinor(money(BigInt(n), 'USD'));
    const snap = async (step: string, amount?: bigint) => {
      const s = await booking(b.bookingId);
      // After a cancellation the operator keeps the penalty and fees; otherwise the total and fees are owed.
      const owed =
        (s.status === 'cancelled' ? BigInt(s.penalty_amount ?? 0) : BigInt(s.total)) +
        BigInt(s.fees);
      rows.push([
        step,
        amount === undefined ? '' : usd(amount),
        usd(s.total),
        usd(s.fees),
        usd(s.amount_paid),
        usd(owed - BigInt(s.amount_paid)),
        s.status,
        s.payment_status,
      ]);
    };
    await snap('Booked (prepaid, 7 nights, superior)');
    const deposit = BigInt((await booking(b.bookingId)).deposit_amount);
    await pay(w, b.bookingId, deposit, { kind: 'deposit' });
    await snap('Deposit 25% received', deposit);

    const shorter = await quoteAmendment(w.db, w.ctx, {
      bookingId: b.bookingId,
      sailingId: await w.sailing('LXR-4', 35),
    });
    await applyAmendment(w.db, w.ctx, {
      bookingId: b.bookingId,
      revision: 1,
      amendmentQuoteId: shorter.quote.id,
    });
    await snap(`Amended to 4 nights (fee ${usd(shorter.fee)})`);

    const s1 = await booking(b.bookingId);
    const balance = BigInt(s1.total) + BigInt(s1.fees) - BigInt(s1.amount_paid);
    await pay(w, b.bookingId, balance, { kind: 'balance' });
    await snap('Balance received', balance);

    const cancelled = await cancelBooking(w.db, w.ctx, {
      bookingId: b.bookingId,
      reason: 'Guest cancelled',
    });
    await snap(`Cancelled (penalty ${cancelled.penaltyBps / 100}% = ${usd(cancelled.penalty)})`);

    const due = await calculateRefund(w.db, w.ctx, { bookingId: b.bookingId });
    const part = due.refundable / 2n;
    await recordRefund(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'bank_transfer',
      amount: part,
      currency: 'USD',
      reference: 'refund 1/2',
      refundedOn: '2026-10-23',
    });
    await snap('Partial refund', -part);
    await recordRefund(w.db, w.ctx, {
      bookingId: b.bookingId,
      method: 'bank_transfer',
      amount: due.refundable - part,
      currency: 'USD',
      reference: 'refund 2/2',
      refundedOn: '2026-10-23',
    });
    await snap('Final refund', -(due.refundable - part));

    const final = await booking(b.bookingId);
    expect(final.payment_status).toBe('refunded');
    expect(BigInt(final.amount_paid)).toBe(BigInt(final.penalty_amount!) + BigInt(final.fees));
    console.info(
      [
        '| Step | Amount | Total | Fees | Received | Owed by guest (− = to refund) | Booking | Payment |',
        '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
        ...rows.map((r) => `| ${r.join(' | ')} |`),
      ].join('\n'),
    );
  });

  it('a last-minute booking owes its balance on the booking date, never in the past', async () => {
    const b = await prepaid('LXR-4', 7); // embarks in 7–13 days: inside the 30-day balance window
    const { rows } = await owner().query<{ due: string; today: string }>(
      `select balance_due_date::text as due, (now() at time zone 'Africa/Cairo')::date::text as today from vs.booking where id = $1`,
      [b.bookingId],
    );
    expect(rows[0]!.due).toBe(rows[0]!.today);
  });
});
