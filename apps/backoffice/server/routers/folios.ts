import { z } from 'zod';
import {
  departureFolios,
  getExtrasSettings,
  getFolio,
  folioInput,
  postCharge,
  postChargeInput,
  saveExtraItem,
  saveExtraItemInput,
  updateVesselFolio,
  updateVesselFolioInput,
  voidCharge,
  voidChargeInput,
  type CheckinScope,
  type StaffContext,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

/** An on-board login is limited to its vessel; office staff see every vessel. */
const scopeOf = (staff: StaffContext): CheckinScope => ({
  vesselId: staff.role === 'onboard' ? staff.vesselId : null,
});

/** Extras on board (E1): the price list, and each cabin's folio from the Check-in screen. */
export const foliosRouter = router({
  settings: procedure('finance').query(({ ctx }) => getExtrasSettings(backofficeDb(), ctx.engine)),
  saveItem: procedure('finance')
    .input(saveExtraItemInput)
    .mutation(({ ctx, input }) => saveExtraItem(backofficeDb(), ctx.engine, input)),
  updateVessel: procedure('finance')
    .input(updateVesselFolioInput)
    .mutation(({ ctx, input }) => updateVesselFolio(backofficeDb(), ctx.engine, input)),
  departure: procedure('folio.view')
    .input(z.object({ legId: z.uuid() }))
    .query(({ ctx, input }) =>
      departureFolios(backofficeDb(), ctx.engine, input.legId, scopeOf(ctx.staff)),
    ),
  get: procedure('folio.view')
    .input(folioInput)
    .query(({ ctx, input }) => getFolio(backofficeDb(), ctx.engine, input, scopeOf(ctx.staff))),
  post: procedure('folio.write')
    .input(postChargeInput)
    .mutation(({ ctx, input }) =>
      postCharge(backofficeDb(), ctx.engine, input, scopeOf(ctx.staff)),
    ),
  void: procedure('folio.write')
    .input(voidChargeInput)
    .mutation(({ ctx, input }) =>
      voidCharge(backofficeDb(), ctx.engine, input, scopeOf(ctx.staff)),
    ),
});
