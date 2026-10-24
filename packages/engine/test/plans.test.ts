import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { addDays, systemActor } from '@vs/shared';
import {
  addCabinCategory,
  addCabins,
  addCancellationPolicy,
  addChildPolicy,
  addItinerary,
  addPaymentPolicy,
  addRatePlan,
  addRoute,
  addSeason,
  addSupplement,
  addUsualPorts,
  addVessel,
  createQuote,
  deleteRatePlan,
  deleteSupplement,
  generateSchedule,
  getPlans,
  getRoutes,
  getSetupChecklist,
  openDatabase,
  setPlanContracts,
  setRates,
  updateRatePlan,
  updateSupplement,
  type EngineContext,
  type VsDatabase,
} from '../src/index';

/** A new company from nothing to its first back-office quote, through the setup functions. */
describe('Rate plans, supplements and the getting-started checklist', () => {
  let db: VsDatabase;
  let ctx: EngineContext;
  let today: string;
  let vesselId: string;
  let categoryId: string;
  let seasonId: string;
  let policies: { child: string; cancellation: string; payment: string };

  beforeAll(async () => {
    db = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
    ctx = { operatorId: await createOperator('Plans test operator'), actor: systemActor('test') };
    const { rows } = await owner().query<{ d: string }>(
      `select (now() at time zone 'Africa/Cairo')::date::text as d`,
    );
    today = rows[0]!.d;
  });

  afterAll(async () => {
    await db.close();
  });

  const steps = async () =>
    Object.fromEntries(
      (await getSetupChecklist(db, ctx)).ships[0]!.steps.map((s) => [s.step, s.done]),
    );

  it('walks the checklist from a new ship to every step done', async () => {
    expect((await getSetupChecklist(db, ctx)).ships).toEqual([]);
    vesselId = (
      await addVessel(db, ctx, {
        code: 'PLANS',
        name: 'Plans Ship',
        type: 'cruise_ship',
        maxGuests: 20,
      })
    ).id;
    expect(await steps()).toMatchObject({ categories: false, cabins: false, backOffice: false });

    categoryId = (
      await addCabinCategory(db, ctx, {
        vesselId,
        code: 'STD',
        nameEn: 'Standard',
        nameAr: 'ستاندرد',
        maxAdults: 2,
        maxOccupancy: 3,
      })
    ).id;
    await addCabins(db, ctx, {
      vesselId,
      categoryId,
      numbers: ['101', '102', '103'],
      effectiveFrom: today,
      reason: 'setup',
    });
    await addUsualPorts(db, ctx);
    const ports = Object.fromEntries(
      (await getRoutes(db, ctx, vesselId)).ports.map((p) => [p.code, p.id]),
    );
    const route = await addRoute(db, ctx, {
      vesselId,
      name: 'Weekly',
      cycleDays: 7,
      validFrom: addDays(today as never, 1),
      stops: [
        { portId: ports.LXR!, dayOffset: 0, embarkAllowed: true, disembarkAllowed: true },
        { portId: ports.ASW!, dayOffset: 4, embarkAllowed: true, disembarkAllowed: true },
        { portId: ports.LXR!, dayOffset: 7, embarkAllowed: true, disembarkAllowed: true },
      ],
    });
    await addItinerary(db, ctx, {
      templateId: route.id,
      code: 'LXR-4',
      nameEn: '4 nights from Luxor',
      nameAr: '٤ ليالٍ من الأقصر',
      embarkStopSeq: 0,
      disembarkStopSeq: 1,
    });
    await generateSchedule(db, ctx, { vesselId, until: addDays(today as never, 20) });
    expect(await steps()).toMatchObject({
      categories: true,
      cabins: true,
      route: true,
      itineraries: true,
      departures: true,
      seasons: false,
      plan: false,
    });

    seasonId = (
      await addSeason(db, ctx, {
        vesselId,
        code: 'ALL',
        name: 'All year',
        periods: [{ from: today, to: addDays(today as never, 400) }],
      })
    ).id;
    policies = {
      child: (
        await addChildPolicy(db, ctx, {
          name: 'Kids',
          bands: [{ ageFrom: 0, ageTo: 11, basis: 'free' }],
        })
      ).id,
      cancellation: (
        await addCancellationPolicy(db, ctx, {
          name: 'Std',
          rules: [{ fromDays: 0, penaltyBps: 10000 }],
        })
      ).id,
      payment: (await addPaymentPolicy(db, ctx, { name: 'Pay' })).id,
    };
    expect(await steps()).toMatchObject({ seasons: true, policies: true, plan: false });

    const plan = await addRatePlan(db, ctx, {
      vesselId,
      code: 'INT',
      name: 'International',
      market: 'international',
      currency: 'USD',
      pricingUnit: 'per_person',
      pricingPeriod: 'per_night',
      childPolicyId: policies.child,
      cancellationPolicyId: policies.cancellation,
      paymentPolicyId: policies.payment,
    });
    const checklist = (await getSetupChecklist(db, ctx)).ships[0]!.steps;
    // STD takes two adults: a single and a double price for the one season.
    expect(checklist.find((s) => s.step === 'prices')).toEqual({
      step: 'prices',
      done: false,
      detail: 2,
    });
    expect(checklist.find((s) => s.step === 'backOffice')!.done).toBe(true);

    await setRates(db, ctx, {
      ratePlanId: plan.id,
      rates: [
        { categoryId, seasonId, basis: 'single', amount: 15000 },
        { categoryId, seasonId, basis: 'double', amount: 10000 },
      ],
    });
    expect(Object.values(await steps()).every(Boolean)).toBe(true);
  });

  it('the office can quote right away through the back-office contract the plan created', async () => {
    const { contracts, plans } = await getPlans(db, ctx, vesselId);
    expect(contracts).toEqual([
      expect.objectContaining({ channelType: 'back_office', ratePlanIds: [plans[0]!.id] }),
    ]);
    const channel = await owner().query<{ id: string }>(
      `select id from vs.channel where operator_id = $1 and type = 'back_office'`,
      [ctx.operatorId],
    );
    const sailing = await owner().query<{ id: string }>(
      `select id from vs.sailing where vessel_id = $1 order by embark_date limit 1`,
      [vesselId],
    );
    const quote = await createQuote(db, ctx, {
      channelId: channel.rows[0]!.id,
      sailingId: sailing.rows[0]!.id,
      market: 'international',
      cabins: [{ categoryId, adults: 2 }],
    });
    expect(quote.currency).toBe('USD');
    expect(quote.total).toBe(2n * 4n * 10000n); // two adults, 4 nights at the double rate
  });

  it('a new category joins the ship’s contracts; plan basics lock once it has prices', async () => {
    const suite = await addCabinCategory(db, ctx, {
      vesselId,
      code: 'STE',
      nameEn: 'Suite',
      nameAr: 'جناح',
      maxAdults: 2,
      maxOccupancy: 2,
    });
    const joined = await owner().query(
      `select 1 from vs.channel_contract_category where category_id = $1`,
      [suite.id],
    );
    expect(joined.rowCount).toBe(1);

    const plan = (await getPlans(db, ctx, vesselId)).plans[0]!;
    const base = {
      ratePlanId: plan.id,
      name: 'International (USD)',
      market: plan.market,
      currency: plan.currency,
      pricingUnit: plan.pricingUnit,
      pricingPeriod: plan.pricingPeriod,
      childPolicyId: policies.child,
      cancellationPolicyId: policies.cancellation,
      paymentPolicyId: policies.payment,
      active: true,
    };
    await expect(updateRatePlan(db, ctx, { ...base, currency: 'EUR' })).rejects.toMatchObject({
      details: { reason: 'plan_has_rates' },
    });
    await updateRatePlan(db, ctx, base);
    const after = (await getPlans(db, ctx, vesselId)).plans[0]!;
    expect(after.name).toBe('International (USD)');
    const events = await owner().query(
      `select count(*)::int as n from vs.event where operator_id = $1 and type = 'rate.changed'`,
      [ctx.operatorId],
    );
    expect(events.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('contracts keep at least one plan; unused plans and supplements can be removed', async () => {
    const { plans, contracts } = await getPlans(db, ctx, vesselId);
    await expect(
      setPlanContracts(db, ctx, { ratePlanId: plans[0]!.id, contractIds: [] }),
    ).rejects.toMatchObject({
      details: { reason: 'contract_needs_plan' },
    });
    await expect(deleteRatePlan(db, ctx, plans[0]!.id)).rejects.toMatchObject({
      details: { reason: 'plan_in_use' },
    });

    const spare = await addRatePlan(db, ctx, {
      vesselId,
      code: 'EGP',
      name: 'Residents',
      market: 'egyptian_resident',
      currency: 'EGP',
      pricingUnit: 'per_cabin',
      pricingPeriod: 'per_night',
      childPolicyId: policies.child,
      cancellationPolicyId: policies.cancellation,
      paymentPolicyId: policies.payment,
      sellInBackOffice: false,
    });
    await setPlanContracts(db, ctx, { ratePlanId: spare.id, contractIds: [contracts[0]!.id] });
    expect((await getPlans(db, ctx, vesselId)).contracts[0]!.ratePlanIds).toHaveLength(2);
    await setPlanContracts(db, ctx, { ratePlanId: spare.id, contractIds: [] });

    const supplement = await addSupplement(db, ctx, {
      ratePlanId: plans[0]!.id,
      code: 'GALA',
      kind: 'gala',
      nameEn: 'New Year gala',
      nameAr: 'حفل رأس السنة',
      dateFrom: '2026-12-31',
      dateTo: '2026-12-31',
      amountAdult: 5000,
      amountChild: 2500,
    });
    await expect(
      addSupplement(db, ctx, {
        ratePlanId: plans[0]!.id,
        code: 'GALA',
        kind: 'gala',
        nameEn: 'x',
        nameAr: 'x',
        dateFrom: '2026-12-31',
        dateTo: '2026-12-31',
        amountAdult: 1,
        amountChild: 1,
      }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });
    await updateSupplement(db, ctx, {
      supplementId: supplement.id,
      kind: 'gala',
      nameEn: 'New Year gala dinner',
      nameAr: 'عشاء رأس السنة',
      dateFrom: '2026-12-31',
      dateTo: '2026-12-31',
      amountAdult: 6000,
      amountChild: 3000,
      mandatory: true,
    });
    await deleteSupplement(db, ctx, supplement.id);
    await deleteRatePlan(db, ctx, spare.id);
    expect((await getPlans(db, ctx, vesselId)).plans.map((p) => p.code)).toEqual(['INT']);
  });
});
