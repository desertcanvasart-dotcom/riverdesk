import { z } from 'zod';
import {
  blockCabins,
  blockCabinsInput,
  emergencyBlock,
  getInventoryGrid,
  releaseBlock,
  releaseBlockInput,
  setStopSale,
  setStopSaleInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inventoryRouter = router({
  grid: procedure('read')
    .input(z.object({ vesselId: z.uuid(), from: date, to: date }))
    .query(({ ctx, input }) => getInventoryGrid(backofficeDb(), ctx.engine, input)),
  block: procedure('inventory.write')
    .input(blockCabinsInput)
    .mutation(({ ctx, input }) => blockCabins(backofficeDb(), ctx.engine, input)),
  /** Out of service now, even beyond free: may over-commit and open an exception. */
  emergencyBlock: procedure('inventory.write')
    .input(blockCabinsInput)
    .mutation(({ ctx, input }) => emergencyBlock(backofficeDb(), ctx.engine, input)),
  release: procedure('inventory.write')
    .input(releaseBlockInput)
    .mutation(({ ctx, input }) => releaseBlock(backofficeDb(), ctx.engine, input)),
  stopSale: procedure('inventory.write')
    .input(setStopSaleInput)
    .mutation(({ ctx, input }) => setStopSale(backofficeDb(), ctx.engine, input)),
});
