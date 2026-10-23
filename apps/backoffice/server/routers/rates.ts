import { z } from 'zod';
import {
  createSupplement,
  createSupplementInput,
  getRatesSetup,
  setRates,
  setRatesInput,
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
    .mutation(({ ctx, input }) => createSupplement(backofficeDb(), ctx.engine, input)),
});
