import {
  addCabinCategory,
  addCabins,
  addCabinsInput,
  addVessel,
  createCabinCategoryInput,
  createVesselInput,
  getFleet,
  updateCabinCategory,
  updateCabinCategoryInput,
  updateVessel,
  updateVesselInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/** Ships & cabins: the company sets up its own fleet (Batch 8, step 1). */
export const fleetRouter = router({
  list: procedure('read').query(({ ctx }) => getFleet(backofficeDb(), ctx.engine)),
  addVessel: procedure('fleet.write')
    .input(createVesselInput)
    .mutation(({ ctx, input }) => addVessel(backofficeDb(), ctx.engine, input)),
  updateVessel: procedure('fleet.write')
    .input(updateVesselInput)
    .mutation(({ ctx, input }) => updateVessel(backofficeDb(), ctx.engine, input)),
  addCategory: procedure('fleet.write')
    .input(createCabinCategoryInput)
    .mutation(({ ctx, input }) => addCabinCategory(backofficeDb(), ctx.engine, input)),
  updateCategory: procedure('fleet.write')
    .input(updateCabinCategoryInput)
    .mutation(({ ctx, input }) => updateCabinCategory(backofficeDb(), ctx.engine, input)),
  /** Same rule as one cabin on the Inventory screen: owners and reservations. */
  addCabins: procedure('inventory.write')
    .input(addCabinsInput)
    .mutation(({ ctx, input }) => addCabins(backofficeDb(), ctx.engine, input)),
});
