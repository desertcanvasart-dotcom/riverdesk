import { owner } from '@vs/db/testing';
import { addDays, type BusinessDate } from '@vs/shared';
import {
  applyScheduleException,
  createCancellationPolicy,
  createChannel,
  createChildPolicy,
  createContract,
  createPaymentPolicy,
  createRatePlan,
  createSeason,
  createSupplement,
  generateSchedule,
  setRates,
} from '../../src/index';
import { demoWorld, type World } from './world';

/**
 * A priced demo vessel with round numbers, so expected totals can be worked out by hand.
 * M is the first Monday of the schedule. Seasons: LOW M … M+13, HIGH M+14 … M+27, none after.
 *
 * Plans
 * - NIGHT: USD, per person per night (market international)
 *     STD LOW single 150.00 double 100.00 triple 80.00 · HIGH single 180.00 double 120.00 triple 100.00
 *     JS LOW single 300.00 double 200.00 · SUP LOW double 100.01
 *     Gala supplements on M+16 and M+18: adult 50.00, child 25.00 per night
 * - PKG: EUR, per person per package (market international_eur)
 *     STD LOW LXR-4 single 750.00 double 500.00 triple 450.00 · LXR-7 double 800.00 · ASW-3 double 400.00
 * - CABIN: EGP, per cabin per package (market egyptian_resident)
 *     STD LOW LXR-4 3,000.00 · RS LOW LXR-4 9,000.00
 *
 * Child policy (pilot): 0–1 free · 2–5 25% · 6–11 50% (both need two adults) · 12+ adult.
 */
export interface PricingWorld extends Omit<World, 'channels'> {
  M: BusinessDate;
  channels: Record<'nilecrz' | 'markup' | 'commission' | 'limited' | 'stopped', string>;
  plans: Record<'NIGHT' | 'PKG' | 'CABIN', string>;
  sailing(pattern: string, embark: BusinessDate): Promise<string>;
}

export async function pricingWorld(): Promise<PricingWorld> {
  const world = await demoWorld({ pricing: false });
  const { db, ctx, demo } = world;
  const M = demo.validFrom;
  await generateSchedule(db, ctx, { vesselId: demo.vesselId, until: addDays(M, 41) });

  const low = await createSeason(db, ctx, {
    vesselId: demo.vesselId,
    code: 'LOW',
    name: 'Low',
    periods: [{ from: M, to: addDays(M, 13) }],
  });
  const high = await createSeason(db, ctx, {
    vesselId: demo.vesselId,
    code: 'HIGH',
    name: 'High',
    periods: [{ from: addDays(M, 14), to: addDays(M, 27) }],
  });

  const child = await createChildPolicy(db, ctx, {
    name: 'Pilot',
    adultFromAge: 12,
    maxChildrenPerCabin: 2,
    bands: [
      { ageFrom: 0, ageTo: 1, basis: 'free' },
      {
        ageFrom: 2,
        ageTo: 5,
        basis: 'percent_of_adult',
        percentBps: 2500,
        requiresTwoAdults: true,
      },
      {
        ageFrom: 6,
        ageTo: 11,
        basis: 'percent_of_adult',
        percentBps: 5000,
        requiresTwoAdults: true,
      },
    ],
  });
  const cancellation = await createCancellationPolicy(db, ctx, {
    name: 'Standard',
    rules: [
      { fromDays: 60, penaltyBps: 0 },
      { fromDays: 30, penaltyBps: 2500 },
      { fromDays: 15, penaltyBps: 5000 },
      { fromDays: 0, penaltyBps: 10000 },
    ],
  });
  const payment = await createPaymentPolicy(db, ctx, { name: 'Prepaid 25%' });
  const policies = {
    childPolicyId: child.id,
    cancellationPolicyId: cancellation.id,
    paymentPolicyId: payment.id,
  };

  const night = await createRatePlan(db, ctx, {
    vesselId: demo.vesselId,
    code: 'NIGHT',
    name: 'Nightly USD',
    market: 'international',
    currency: 'USD',
    pricingUnit: 'per_person',
    pricingPeriod: 'per_night',
    ...policies,
    inclusions: { en: ['Full board'], ar: ['إقامة كاملة'] },
  });
  const pkg = await createRatePlan(db, ctx, {
    vesselId: demo.vesselId,
    code: 'PKG',
    name: 'Package EUR',
    market: 'international_eur',
    currency: 'EUR',
    pricingUnit: 'per_person',
    pricingPeriod: 'per_package',
    ...policies,
  });
  const cabin = await createRatePlan(db, ctx, {
    vesselId: demo.vesselId,
    code: 'CABIN',
    name: 'Cabin EGP',
    market: 'egyptian_resident',
    currency: 'EGP',
    pricingUnit: 'per_cabin',
    pricingPeriod: 'per_package',
    ...policies,
  });

  const { STD, SUP, JS, RS } = demo.categories;
  const p = demo.patterns;
  await setRates(db, ctx, {
    ratePlanId: night.id,
    rates: [
      { categoryId: STD, seasonId: low.id, basis: 'single', amount: 15000 },
      { categoryId: STD, seasonId: low.id, basis: 'double', amount: 10000 },
      { categoryId: STD, seasonId: low.id, basis: 'triple', amount: 8000 },
      { categoryId: STD, seasonId: high.id, basis: 'single', amount: 18000 },
      { categoryId: STD, seasonId: high.id, basis: 'double', amount: 12000 },
      { categoryId: STD, seasonId: high.id, basis: 'triple', amount: 10000 },
      { categoryId: JS, seasonId: low.id, basis: 'single', amount: 30000 },
      { categoryId: JS, seasonId: low.id, basis: 'double', amount: 20000 },
      { categoryId: SUP, seasonId: low.id, basis: 'double', amount: 10001 },
    ],
  });
  await setRates(db, ctx, {
    ratePlanId: pkg.id,
    rates: [
      {
        categoryId: STD,
        seasonId: low.id,
        sailingPatternId: p['LXR-4'],
        basis: 'single',
        amount: 75000,
      },
      {
        categoryId: STD,
        seasonId: low.id,
        sailingPatternId: p['LXR-4'],
        basis: 'double',
        amount: 50000,
      },
      {
        categoryId: STD,
        seasonId: low.id,
        sailingPatternId: p['LXR-4'],
        basis: 'triple',
        amount: 45000,
      },
      {
        categoryId: STD,
        seasonId: low.id,
        sailingPatternId: p['LXR-7'],
        basis: 'double',
        amount: 80000,
      },
      {
        categoryId: STD,
        seasonId: low.id,
        sailingPatternId: p['ASW-3'],
        basis: 'double',
        amount: 40000,
      },
    ],
  });
  await setRates(db, ctx, {
    ratePlanId: cabin.id,
    rates: [
      { categoryId: STD, seasonId: low.id, sailingPatternId: p['LXR-4'], amount: 300000 },
      { categoryId: RS, seasonId: low.id, sailingPatternId: p['LXR-4'], amount: 900000 },
    ],
  });
  for (const [code, day] of [
    ['GALA1', 16],
    ['GALA2', 18],
  ] as const) {
    await createSupplement(db, ctx, {
      ratePlanId: night.id,
      code,
      kind: 'gala',
      nameEn: `Gala ${day}`,
      nameAr: 'حفل',
      dateFrom: addDays(M, day),
      dateTo: addDays(M, day),
      amountAdult: 5000,
      amountChild: 2500,
    });
  }

  const all = Object.values(demo.categories);
  const contract = async (
    code: string,
    type: 'portal' | 'agent',
    options: Partial<Parameters<typeof createContract>[2]> = {},
  ) => {
    const channel = await createChannel(db, ctx, { code, name: code, type });
    await createContract(db, ctx, {
      channelId: channel.id,
      vesselId: demo.vesselId,
      allocation: 'pool',
      paymentMode: 'channel_collected',
      validFrom: M,
      categoryIds: all,
      ratePlanIds: [night.id, pkg.id, cabin.id],
      ...options,
    });
    return channel.id;
  };
  const channels = {
    nilecrz: await contract('nilecrz', 'portal'),
    markup: await contract('markup-agent', 'agent', {
      priceAdjustment: 'markup',
      adjustmentBps: 1000,
      ratePlanIds: [night.id],
    }),
    commission: await contract('commission-agent', 'agent', {
      priceAdjustment: 'commission',
      adjustmentBps: 1500,
      paymentMode: 'credit',
      ratePlanIds: [night.id],
    }),
    limited: await contract('limited-agent', 'agent', {
      categoryIds: [STD],
      ratePlanIds: [night.id],
    }),
    stopped: await contract('stopped-agent', 'agent', { stopSell: true }),
  };

  const sailing = async (pattern: string, embark: BusinessDate) => {
    const { rows } = await owner().query<{ id: string }>(
      `select s.id from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id
       where s.vessel_id = $1 and sp.code = $2 and s.embark_date = $3`,
      [demo.vesselId, pattern, embark],
    );
    if (!rows[0]) throw new Error(`No ${pattern} sailing on ${embark}`);
    return rows[0].id;
  };

  // A cancelled departure (week 6) for the SAILING_CLOSED case.
  const { rows } = await owner().query<{ id: string }>(
    `select id from vs.leg where vessel_id = $1 and depart_date = $2`,
    [demo.vesselId, addDays(M, 35)],
  );
  await applyScheduleException(db, ctx, {
    vesselId: demo.vesselId,
    kind: 'cancel',
    legIds: [rows[0]!.id],
    reason: 'test',
  });

  return {
    ...world,
    M,
    channels,
    plans: { NIGHT: night.id, PKG: pkg.id, CABIN: cabin.id },
    sailing,
  };
}
