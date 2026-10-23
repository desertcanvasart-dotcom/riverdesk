import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import { createQuote, getQuote, setRates, useQuote } from '../src/index';
import { pricingWorld, type PricingWorld } from './helpers/pricing-world';

describe('quotes', () => {
  let world: PricingWorld;
  let sailingId: string;
  const request = () => ({
    channelId: world.channels.nilecrz,
    sailingId,
    market: 'international',
    cabins: [{ categoryId: world.demo.categories.STD, adults: 2, childAges: [7] }],
  });

  beforeAll(async () => {
    world = await pricingWorld();
    sailingId = await world.sailing('LXR-4', world.M);
  }, 120_000);

  afterAll(async () => {
    await world.close();
  });

  it('stores price lines, policy snapshots and an expiry no shorter than the longest hold', async () => {
    const quote = await createQuote(world.db, world.ctx, request());
    expect(quote).toMatchObject({
      status: 'valid',
      currency: 'USD',
      total: 100000n,
      netTotal: 100000n,
    });
    expect(quote.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['adult', '40000'],
      ['adult', '40000'],
      ['child', '20000'],
    ]);
    expect(quote.policies).toMatchObject({
      rate_plan: { code: 'NIGHT', currency: 'USD', pricing_unit: 'per_person' },
      cancellation: {
        rules: [
          { from_days: 60, penalty_bps: 0 },
          { from_days: 30, penalty_bps: 2500 },
          { from_days: 15, penalty_bps: 5000 },
          { from_days: 0, penalty_bps: 10000 },
        ],
      },
      payment: { deposit_bps: 2500, balance_due_days: 30 },
      child: {
        adult_from_age: 12,
        bands: expect.arrayContaining([
          expect.objectContaining({ age_from: 6, age_to: 11, percent_bps: 5000 }),
        ]),
      },
      inclusions: { en: ['Full board'] },
      contract: { payment_mode: 'channel_collected', allocation: 'pool' },
    });
    // nilecrz contract: checkout 30 min, option 72 h → the quote lives 72 h.
    const { rows } = await owner().query<{ hours: number }>(
      `select round(extract(epoch from expires_at - created_at) / 3600)::int as hours from vs.quote where id = $1`,
      [quote.id],
    );
    expect(rows[0]!.hours).toBe(72);
    const audit = await owner().query(
      `select 1 from vs.audit_log where entity = 'quote' and entity_id = $1`,
      [quote.id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('a rate change after the quote leaves the quote unchanged', async () => {
    const before = await createQuote(world.db, world.ctx, request());
    const low = await owner().query<{ id: string }>(
      `select id from vs.season where vessel_id = $1 and code = 'LOW'`,
      [world.demo.vesselId],
    );
    await setRates(world.db, world.ctx, {
      ratePlanId: world.plans.NIGHT,
      rates: [
        {
          categoryId: world.demo.categories.STD,
          seasonId: low.rows[0]!.id,
          basis: 'double',
          amount: 11000,
        },
      ],
    });
    const again = await getQuote(world.db, world.ctx, { quoteId: before.id });
    expect(again.total).toBe(100000n);
    expect(again.lines).toEqual(before.lines);
    const fresh = await createQuote(world.db, world.ctx, request());
    expect(fresh.total).toBe(110000n); // 2 × 110.00 × 4 + 50% × 440.00
    const events = await owner().query(
      `select 1 from vs.event where type = 'rate.changed' and resource_id = $1`,
      [world.plans.NIGHT],
    );
    expect(events.rowCount).toBeGreaterThanOrEqual(2);
  });

  it('expires by database time: a hold can no longer use it', async () => {
    const quote = await createQuote(world.db, world.ctx, request());
    await owner().query(
      `update vs.quote set expires_at = now() - interval '1 second' where id = $1`,
      [quote.id],
    );
    expect((await getQuote(world.db, world.ctx, { quoteId: quote.id })).status).toBe('expired');
    const error = await world.db
      .withTenantTx(world.ctx.operatorId, world.ctx.actor, ({ db: tx }) =>
        useQuote(tx, quote.id, world.channels.nilecrz),
      )
      .catch((e: unknown) => e);
    expect(isDomainError(error, 'QUOTE_EXPIRED')).toBe(true);
  });

  it('belongs to its channel', async () => {
    const quote = await createQuote(world.db, world.ctx, request());
    const error = await world.db
      .withTenantTx(world.ctx.operatorId, world.ctx.actor, ({ db: tx }) =>
        useQuote(tx, quote.id, world.channels.markup),
      )
      .catch((e: unknown) => e);
    expect(isDomainError(error, 'CONTRACT_FORBIDS')).toBe(true);
  });

  it('cannot be edited by runtime roles', async () => {
    const quote = await createQuote(world.db, world.ctx, request());
    await expect(
      world.db.withTenantTx(world.ctx.operatorId, world.ctx.actor, ({ db: tx }) =>
        sql`update vs.quote set total = 1 where id = ${quote.id}`.execute(tx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
