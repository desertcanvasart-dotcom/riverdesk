import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { addDays } from '@vs/shared';
import {
  addCabinCategory,
  addCabins,
  addItinerary,
  addCancellationPolicy,
  addChildPolicy,
  addPaymentPolicy,
  addRoute,
  addSeason,
  addVessel,
  createQuote,
  deletePolicy,
  deleteSeason,
  generateSchedule,
  getPolicies,
  getSeasons,
  updateCancellationPolicy,
  updateChildPolicy,
  updatePaymentPolicy,
  updateSeason,
} from '../src/index';
import { demoWorld, legs, sailingOverLeg, type World } from './helpers/world';

describe('Seasons and policies (setup screens)', () => {
  let world: World;
  let today: string;

  beforeAll(async () => {
    world = await demoWorld();
    await generateSchedule(world.db, world.ctx, {
      vesselId: world.demo.vesselId,
      until: addDays(world.demo.validFrom, 13),
    });
    const { rows } = await owner().query<{ d: string }>(
      `select (now() at time zone 'Africa/Cairo')::date::text as d`,
    );
    today = rows[0]!.d;
  });

  afterAll(async () => {
    await world.close();
  });

  const planVersions = async () =>
    (
      await owner().query<{ id: string; version: string }>(
        `select id, version from vs.rate_plan where operator_id = $1 order by id`,
        [world.ctx.operatorId],
      )
    ).rows.map((r) => Number(r.version));
  const rateEvents = async () =>
    (
      await owner().query(
        `select count(*)::int as n from vs.event where operator_id = $1 and type = 'rate.changed'`,
        [world.ctx.operatorId],
      )
    ).rows[0].n as number;

  it('lists the ship’s seasons with their rates, and refuses overlaps and repeated codes', async () => {
    const { seasons } = await getSeasons(world.db, world.ctx, world.demo.vesselId);
    expect(seasons.length).toBeGreaterThan(0);
    expect(seasons.every((s) => s.rates > 0)).toBe(true);
    const taken = seasons[0]!;
    const covered = taken.periods[0]!.from;

    await expect(
      addSeason(world.db, world.ctx, {
        vesselId: world.demo.vesselId,
        code: 'NEW',
        name: 'Overlaps',
        periods: [{ from: covered, to: covered }],
      }),
    ).rejects.toMatchObject({ details: { reason: 'season_overlap' } });
    await expect(
      addSeason(world.db, world.ctx, {
        vesselId: world.demo.vesselId,
        code: 'NEW',
        name: 'Self overlap',
        periods: [
          { from: '2035-01-01', to: '2035-01-10' },
          { from: '2035-01-05', to: '2035-01-20' },
        ],
      }),
    ).rejects.toMatchObject({ details: { reason: 'periods_overlap' } });
    await expect(
      addSeason(world.db, world.ctx, {
        vesselId: world.demo.vesselId,
        code: taken.code,
        name: 'Same code',
        periods: [{ from: '2036-01-01', to: '2036-01-02' }],
      }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });
  });

  it('shows the nights a new ship sails with no season, until seasons cover them', async () => {
    const ship = await addVessel(world.db, world.ctx, {
      code: 'SEASONS',
      name: 'Seasons Ship',
      type: 'dahabiya',
      maxGuests: 12,
    });
    const category = await addCabinCategory(world.db, world.ctx, {
      vesselId: ship.id,
      code: 'STD',
      nameEn: 'Standard',
      nameAr: 'ستاندرد',
      maxAdults: 2,
      maxOccupancy: 2,
    });
    await addCabins(world.db, world.ctx, {
      vesselId: ship.id,
      categoryId: category.id,
      numbers: ['1'],
      effectiveFrom: today,
      reason: 'setup',
    });
    const route = await addRoute(world.db, world.ctx, {
      vesselId: ship.id,
      name: 'Weekly',
      cycleDays: 7,
      validFrom: world.demo.validFrom,
      stops: [
        {
          portId: world.demo.ports.LXR!,
          dayOffset: 0,
          embarkAllowed: true,
          disembarkAllowed: true,
        },
        {
          portId: world.demo.ports.LXR!,
          dayOffset: 7,
          embarkAllowed: true,
          disembarkAllowed: true,
        },
      ],
    });
    await addItinerary(world.db, world.ctx, {
      templateId: route.id,
      code: 'WEEK',
      nameEn: 'A week',
      nameAr: 'أسبوع',
      embarkStopSeq: 0,
      disembarkStopSeq: 1,
    });
    await generateSchedule(world.db, world.ctx, {
      vesselId: ship.id,
      until: addDays(world.demo.validFrom, 13),
    });
    // Sailings start on validFrom and a week later; a sailing is priced by its start date.
    const week1 = world.demo.validFrom;
    const week2 = addDays(world.demo.validFrom, 7);
    const start = week1 > today ? week1 : today;
    let result = await getSeasons(world.db, world.ctx, ship.id);
    expect(result.uncovered).toEqual([{ from: week1, to: week2, sailings: 2 }]);

    const season = await addSeason(world.db, world.ctx, {
      vesselId: ship.id,
      code: 'LOW',
      name: 'Low',
      periods: [{ from: start, to: addDays(world.demo.validFrom, 6) }],
    });
    result = await getSeasons(world.db, world.ctx, ship.id);
    expect(result.uncovered).toEqual([{ from: week2, to: week2, sailings: 1 }]);
    await updateSeason(world.db, world.ctx, {
      seasonId: season.id,
      name: 'Low season',
      periods: [{ from: start, to: week2 }],
    });
    result = await getSeasons(world.db, world.ctx, ship.id);
    expect(result.uncovered).toEqual([]);
    expect(result.seasons[0]).toMatchObject({ name: 'Low season', rates: 0 });

    // A season without rates can go; one with rates cannot.
    await deleteSeason(world.db, world.ctx, season.id);
    const demoSeason = (await getSeasons(world.db, world.ctx, world.demo.vesselId)).seasons[0]!;
    await expect(deleteSeason(world.db, world.ctx, demoSeason.id)).rejects.toMatchObject({
      details: { reason: 'season_in_use' },
    });
  });

  it('a season edit bumps the ship’s rate plans and tells channels', async () => {
    const before = await planVersions();
    const events = await rateEvents();
    const season = (await getSeasons(world.db, world.ctx, world.demo.vesselId)).seasons[0]!;
    await updateSeason(world.db, world.ctx, {
      seasonId: season.id,
      name: `${season.name} (renamed)`,
      periods: season.periods,
    });
    const after = await planVersions();
    expect(after.map((v, i) => v - before[i]!)).toEqual(before.map(() => 1));
    expect(await rateEvents()).toBe(events + before.length);
  });

  it('policies: rules are checked, edits reach new quotes only, used ones cannot be deleted', async () => {
    const policies = await getPolicies(world.db, world.ctx);
    const child = policies.children[0]!;
    const cancellation = policies.cancellation[0]!;
    const payment = policies.payment[0]!;
    expect(child.plans).toBeGreaterThan(0);

    // A quote made now keeps today's cancellation terms after the policy changes.
    const leg = (await legs(world.demo.vesselId))[0]!;
    const quote = await createQuote(world.db, world.ctx, {
      channelId: world.channels.nilecrz,
      sailingId: await sailingOverLeg(leg.id),
      market: 'international',
      cabins: [{ categoryId: world.demo.categories.STD, adults: 2 }],
    });
    const snapshot = async () =>
      (await owner().query(`select policies from vs.quote where id = $1`, [quote.id])).rows[0]
        .policies;
    const kept = await snapshot();

    await expect(
      updateCancellationPolicy(world.db, world.ctx, {
        policyId: cancellation.id,
        name: cancellation.name,
        rules: [{ fromDays: 30, penaltyBps: 1000 }],
      }),
    ).rejects.toMatchObject({ details: { reason: 'needs_day0' } });
    await updateCancellationPolicy(world.db, world.ctx, {
      policyId: cancellation.id,
      name: 'Stricter',
      rules: [
        { fromDays: 60, penaltyBps: 2500 },
        { fromDays: 0, penaltyBps: 10000 },
      ],
      amendmentFees: [
        { changeKind: 'date', fromDays: 0, feeKind: 'flat', amount: 5000, currency: 'EGP' },
      ],
    });
    expect(await snapshot()).toEqual(kept);
    const updated = (await getPolicies(world.db, world.ctx)).cancellation.find(
      (p) => p.id === cancellation.id,
    )!;
    expect(updated.rules).toEqual([
      { fromDays: 60, penaltyBps: 2500 },
      { fromDays: 0, penaltyBps: 10000 },
    ]);
    expect(updated.fees).toEqual([
      expect.objectContaining({ changeKind: 'date', feeKind: 'flat', amount: '5000' }),
    ]);

    await expect(
      updateChildPolicy(world.db, world.ctx, {
        policyId: child.id,
        name: child.name,
        adultFromAge: 12,
        bands: [
          { ageFrom: 0, ageTo: 1, basis: 'free' },
          { ageFrom: 3, ageTo: 11, basis: 'percent_of_adult', percentBps: 5000 },
        ],
      }),
    ).rejects.toMatchObject({ details: { reason: 'bands_gap', age: 2 } });
    await updateChildPolicy(world.db, world.ctx, {
      policyId: child.id,
      name: child.name,
      adultFromAge: 12,
      maxChildrenPerCabin: 2,
      bands: [
        { ageFrom: 0, ageTo: 5, basis: 'free' },
        { ageFrom: 6, ageTo: 11, basis: 'percent_of_adult', percentBps: 5000 },
      ],
    });

    await expect(
      updatePaymentPolicy(world.db, world.ctx, {
        policyId: payment.id,
        name: payment.name,
        autoCancelOverdue: true,
      }),
    ).rejects.toMatchObject({ details: { reason: 'auto_cancel_days' } });
    await updatePaymentPolicy(world.db, world.ctx, {
      policyId: payment.id,
      name: payment.name,
      depositBps: 3000,
      balanceDueDays: 45,
    });

    await expect(
      deletePolicy(world.db, world.ctx, { kind: 'payment', policyId: payment.id }),
    ).rejects.toMatchObject({ details: { reason: 'policy_in_use' } });
    const spare = [
      {
        kind: 'child' as const,
        id: (
          await addChildPolicy(world.db, world.ctx, {
            name: 'Spare',
            bands: [{ ageFrom: 0, ageTo: 11, basis: 'free' }],
          })
        ).id,
      },
      {
        kind: 'cancellation' as const,
        id: (
          await addCancellationPolicy(world.db, world.ctx, {
            name: 'Spare',
            rules: [{ fromDays: 0, penaltyBps: 10000 }],
          })
        ).id,
      },
      {
        kind: 'payment' as const,
        id: (await addPaymentPolicy(world.db, world.ctx, { name: 'Spare' })).id,
      },
    ];
    for (const p of spare)
      await deletePolicy(world.db, world.ctx, { kind: p.kind, policyId: p.id });
    const left = await getPolicies(world.db, world.ctx);
    expect(
      [...left.children, ...left.cancellation, ...left.payment].some((p) => p.name === 'Spare'),
    ).toBe(false);
  });
});
