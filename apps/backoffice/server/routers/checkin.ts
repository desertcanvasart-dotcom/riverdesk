import { z } from 'zod';
import {
  checkinDepartures,
  checkinDeparturesInput,
  checkinPackSends,
  departureCheckin,
  getFleet,
  requestCheckinPack,
  setCheckin,
  setCheckinInput,
  updateVesselCheckin,
  updateVesselCheckinInput,
  type CheckinScope,
  type StaffContext,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { can } from '../permissions';
import { procedure, router } from '../trpc';

/** An on-board login is limited to its vessel; office staff see every vessel. */
const scopeOf = (staff: StaffContext): CheckinScope => ({
  vesselId: staff.role === 'onboard' ? staff.vesselId : null,
});

/** Check-in (Batch D2): the reception's screen, on a desk or a phone. */
export const checkinRouter = router({
  departures: procedure('checkin.view')
    .input(checkinDeparturesInput)
    .query(({ ctx, input }) =>
      checkinDepartures(backofficeDb(), ctx.engine, input, scopeOf(ctx.staff)),
    ),
  /** Who boards one departure; balances only for roles that see money. */
  departure: procedure('checkin.view')
    .input(z.object({ legId: z.uuid() }))
    .query(({ ctx, input }) =>
      departureCheckin(backofficeDb(), ctx.engine, input.legId, {
        ...scopeOf(ctx.staff),
        withMoney: can(ctx.staff.role, 'read'),
      }),
    ),
  set: procedure('checkin.write')
    .input(setCheckinInput)
    .mutation(({ ctx, input }) =>
      setCheckin(backofficeDb(), ctx.engine, input, scopeOf(ctx.staff)),
    ),
  /** Emails the check-in pack (passport numbers) to the vessel now. */
  sendPack: procedure('manifests')
    .input(z.object({ legId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      requestCheckinPack(backofficeDb(), ctx.engine, input.legId, scopeOf(ctx.staff)),
    ),
  packSends: procedure('checkin.view')
    .input(z.object({ legId: z.uuid() }))
    .query(({ ctx, input }) =>
      checkinPackSends(backofficeDb(), ctx.engine, input.legId, scopeOf(ctx.staff)),
    ),
  /** Each vessel's on-board email and automatic pack (office only). */
  vessels: procedure('read').query(async ({ ctx }) =>
    (await getFleet(backofficeDb(), ctx.engine)).map((v) => ({
      id: v.id,
      name: v.name,
      onboardEmail: v.onboardEmail,
      checkinPackHours: v.checkinPackHours,
    })),
  ),
  updateVessel: procedure('fleet.write')
    .input(updateVesselCheckinInput)
    .mutation(({ ctx, input }) => updateVesselCheckin(backofficeDb(), ctx.engine, input)),
});
