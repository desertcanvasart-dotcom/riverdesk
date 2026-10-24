import { z } from 'zod';
import {
  addRatePlan,
  addRatePlanInput,
  addSupplement,
  deleteRatePlan,
  deleteSupplement,
  getPlans,
  setPlanContracts,
  setPlanContractsInput,
  updateRatePlan,
  updateRatePlanInput,
  updateSupplement,
  updateSupplementInput,
  addCancellationPolicy,
  addChildPolicy,
  addPaymentPolicy,
  addSeason,
  createCancellationPolicyInput,
  createChildPolicyInput,
  createPaymentPolicyInput,
  createSeasonInput,
  createSupplementInput,
  deletePolicy,
  deletePolicyInput,
  deleteSeason,
  getPolicies,
  getRatesSetup,
  getSeasons,
  setRates,
  setRatesInput,
  updateCancellationPolicy,
  updateCancellationPolicyInput,
  updateChildPolicy,
  updateChildPolicyInput,
  updatePaymentPolicy,
  updatePaymentPolicyInput,
  updateSeason,
  updateSeasonInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const ratesRouter = router({
  setup: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => getRatesSetup(backofficeDb(), ctx.engine, input.vesselId)),
  set: procedure('rates.write')
    .input(setRatesInput)
    .mutation(({ ctx, input }) => setRates(backofficeDb(), ctx.engine, input)),
  addSupplement: procedure('rates.write')
    .input(createSupplementInput)
    .mutation(({ ctx, input }) => addSupplement(backofficeDb(), ctx.engine, input)),
  updateSupplement: procedure('rates.write')
    .input(updateSupplementInput)
    .mutation(({ ctx, input }) => updateSupplement(backofficeDb(), ctx.engine, input)),
  deleteSupplement: procedure('rates.write')
    .input(z.object({ supplementId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteSupplement(backofficeDb(), ctx.engine, input.supplementId)),

  // Rate plans (Batch 8, step 4)
  plans: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => getPlans(backofficeDb(), ctx.engine, input.vesselId)),
  addPlan: procedure('rates.write')
    .input(addRatePlanInput)
    .mutation(({ ctx, input }) => addRatePlan(backofficeDb(), ctx.engine, input)),
  updatePlan: procedure('rates.write')
    .input(updateRatePlanInput)
    .mutation(({ ctx, input }) => updateRatePlan(backofficeDb(), ctx.engine, input)),
  setPlanContracts: procedure('rates.write')
    .input(setPlanContractsInput)
    .mutation(({ ctx, input }) => setPlanContracts(backofficeDb(), ctx.engine, input)),
  deletePlan: procedure('rates.write')
    .input(z.object({ ratePlanId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteRatePlan(backofficeDb(), ctx.engine, input.ratePlanId)),

  // Seasons and policies (Batch 8, step 3)
  seasons: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => getSeasons(backofficeDb(), ctx.engine, input.vesselId)),
  addSeason: procedure('rates.write')
    .input(createSeasonInput)
    .mutation(({ ctx, input }) => addSeason(backofficeDb(), ctx.engine, input)),
  updateSeason: procedure('rates.write')
    .input(updateSeasonInput)
    .mutation(({ ctx, input }) => updateSeason(backofficeDb(), ctx.engine, input)),
  deleteSeason: procedure('rates.write')
    .input(z.object({ seasonId: z.uuid() }))
    .mutation(({ ctx, input }) => deleteSeason(backofficeDb(), ctx.engine, input.seasonId)),
  policies: procedure('read').query(({ ctx }) => getPolicies(backofficeDb(), ctx.engine)),
  addChildPolicy: procedure('rates.write')
    .input(createChildPolicyInput)
    .mutation(({ ctx, input }) => addChildPolicy(backofficeDb(), ctx.engine, input)),
  updateChildPolicy: procedure('rates.write')
    .input(updateChildPolicyInput)
    .mutation(({ ctx, input }) => updateChildPolicy(backofficeDb(), ctx.engine, input)),
  addCancellationPolicy: procedure('rates.write')
    .input(createCancellationPolicyInput)
    .mutation(({ ctx, input }) => addCancellationPolicy(backofficeDb(), ctx.engine, input)),
  updateCancellationPolicy: procedure('rates.write')
    .input(updateCancellationPolicyInput)
    .mutation(({ ctx, input }) => updateCancellationPolicy(backofficeDb(), ctx.engine, input)),
  addPaymentPolicy: procedure('rates.write')
    .input(createPaymentPolicyInput)
    .mutation(({ ctx, input }) => addPaymentPolicy(backofficeDb(), ctx.engine, input)),
  updatePaymentPolicy: procedure('rates.write')
    .input(updatePaymentPolicyInput)
    .mutation(({ ctx, input }) => updatePaymentPolicy(backofficeDb(), ctx.engine, input)),
  deletePolicy: procedure('rates.write')
    .input(deletePolicyInput)
    .mutation(({ ctx, input }) => deletePolicy(backofficeDb(), ctx.engine, input)),
});
