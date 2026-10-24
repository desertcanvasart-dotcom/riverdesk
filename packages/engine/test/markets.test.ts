import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays } from '@vs/shared';
import {
  addMarket,
  addRatePlan,
  bookingDocumentData,
  createQuote,
  deleteMarket,
  generateSchedule,
  getPolicies,
  getSeasons,
  listMarkets,
  setRates,
  staffBook,
  updateMarket,
} from '../src/index';
import { demoWorld, legs, sailingOverLeg, type World } from './helpers/world';

describe('markets and currencies', () => {
  let world: World;
  let policies: { child: string; cancellation: string; payment: string };

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 13),
    });
    const p = await getPolicies(world.db, world.ctx);
    policies = {
      child: p.children[0]!.id,
      cancellation: p.cancellation[0]!.id,
      payment: p.payment[0]!.id,
    };
  });

  afterAll(async () => {
    await world.close();
  });

  /** A per-cabin, per-night plan in this market and currency with one price for every cell. */
  const planIn = async (code: string, market: string, currency: string, amount: number) => {
    const plan = await addRatePlan(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      code,
      name: code,
      market,
      currency,
      pricingUnit: 'per_cabin',
      pricingPeriod: 'per_night',
      childPolicyId: policies.child,
      cancellationPolicyId: policies.cancellation,
      paymentPolicyId: policies.payment,
    });
    const { seasons } = await getSeasons(world.db, world.ctx, world.demo.vesselId);
    await setRates(world.db, world.ctx, {
      ratePlanId: plan.id,
      rates: Object.values(world.demo.categories).flatMap((categoryId) =>
        seasons.map((s) => ({ categoryId, seasonId: s.id, amount })),
      ),
    });
    return plan;
  };

  it('a new company starts with International and Egyptian resident', async () => {
    const markets = await listMarkets(world.db, world.ctx);
    expect(markets.map((m) => [m.code, m.needsResidencyProof])).toEqual([
      ['international', false],
      ['egyptian_resident', true],
    ]);
    expect(markets[0]!.plans).toBeGreaterThan(0);
  });

  it('adds markets, refuses repeats, and plans only in known, offered markets', async () => {
    await addMarket(world.db, world.ctx, {
      code: 'gcc',
      nameEn: 'Gulf (GCC)',
      nameAr: 'دول الخليج',
      needsResidencyProof: false,
    });
    await expect(
      addMarket(world.db, world.ctx, {
        code: 'gcc',
        nameEn: 'x',
        nameAr: 'x',
        needsResidencyProof: true,
      }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });
    await expect(planIn('MARS', 'mars', 'USD', 100)).rejects.toMatchObject({
      details: { reason: 'unknown_market' },
    });

    const european = await addMarket(world.db, world.ctx, {
      code: 'european',
      nameEn: 'European',
      nameAr: 'أوروبي',
      needsResidencyProof: true,
    });
    await updateMarket(world.db, world.ctx, {
      marketId: european.id,
      nameEn: 'European',
      nameAr: 'أوروبي',
      needsResidencyProof: true,
      active: false,
    });
    await expect(planIn('EUR1', 'european', 'EUR', 100)).rejects.toMatchObject({
      details: { reason: 'unknown_market' },
    });
    await deleteMarket(world.db, world.ctx, european.id);
    const intl = (await listMarkets(world.db, world.ctx)).find((m) => m.code === 'international')!;
    await expect(deleteMarket(world.db, world.ctx, intl.id)).rejects.toMatchObject({
      details: { reason: 'market_in_use' },
    });
  });

  it('a GCC booking in SAR: the voucher asks for no residency proof; Egyptian residents do', async () => {
    await planIn('GCC', 'gcc', 'SAR', 50000); // SAR 500.00 a cabin a night
    const leg = (await legs(world.demo.vesselId))[0]!;
    const sailingId = await sailingOverLeg(leg.id);
    const book = (market: string, key: string) =>
      staffBook(world.db, world.ctx, {
        channelId: world.channels.backOffice,
        sailingId,
        market,
        cabins: [{ categoryId: world.demo.categories.STD, adults: 2 }],
        guests: [{ cabin: 0, firstName: 'Noura', lastName: key, lead: true }],
        requestKey: `markets-${key}`,
      });
    const gcc = await book('gcc', 'gcc-booking');
    const booking = await owner().query(
      `select market, currency, total from vs.booking where id = $1`,
      [gcc.bookingId],
    );
    expect(booking.rows[0]).toMatchObject({ market: 'gcc', currency: 'SAR' });
    expect(
      (await bookingDocumentData(world.db, world.ctx, gcc.bookingId)).needsResidencyProof,
    ).toBe(false);

    const resident = await book('egyptian_resident', 'resident-booking');
    expect(
      (await bookingDocumentData(world.db, world.ctx, resident.bookingId)).needsResidencyProof,
    ).toBe(true);
  });

  it('prices in a 3-decimal currency: 1.250 KWD a night stays 1250 fils', async () => {
    await addMarket(world.db, world.ctx, {
      code: 'kuwait',
      nameEn: 'Kuwait',
      nameAr: 'الكويت',
      needsResidencyProof: false,
    });
    await planIn('KWT', 'kuwait', 'KWD', 1250);
    const leg = (await legs(world.demo.vesselId))[0]!;
    const quote = await createQuote(world.db, world.ctx, {
      channelId: world.channels.backOffice,
      sailingId: await sailingOverLeg(leg.id),
      market: 'kuwait',
      cabins: [{ categoryId: world.demo.categories.STD, adults: 2 }],
    });
    expect(quote.currency).toBe('KWD');
    expect(quote.total).toBe(1250n * 4n); // 4 nights × 1.250 KWD = 5.000 KWD
  });
});
