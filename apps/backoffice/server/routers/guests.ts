import { z } from 'zod';
import {
  assignCabin,
  assignCabinInput,
  autoAssignCabins,
  autoAssignCabinsInput,
  cabinOptions,
  getLegManifest,
  listDepartures,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Guests per departure and their cabins. Passport numbers never reach the screen. */
export const guestsRouter = router({
  departures: procedure('read')
    .input(z.object({ vesselId: z.uuid(), from: date, to: date }))
    .query(({ ctx, input }) => listDepartures(backofficeDb(), ctx.engine, input)),
  manifest: procedure('read')
    .input(z.object({ legId: z.uuid() }))
    .query(({ ctx, input }) => getLegManifest(backofficeDb(), ctx.engine, input.legId)),
  cabinOptions: procedure('read')
    .input(z.object({ bookingCabinId: z.uuid() }))
    .query(({ ctx, input }) => cabinOptions(backofficeDb(), ctx.engine, input.bookingCabinId)),
  autoAssign: procedure('guests.assign')
    .input(autoAssignCabinsInput)
    .mutation(({ ctx, input }) => autoAssignCabins(backofficeDb(), ctx.engine, input)),
  assign: procedure('guests.assign')
    .input(assignCabinInput)
    .mutation(({ ctx, input }) => assignCabin(backofficeDb(), ctx.engine, input)),
});
