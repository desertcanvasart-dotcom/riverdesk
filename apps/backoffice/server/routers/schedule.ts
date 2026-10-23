import { z } from 'zod';
import {
  applyScheduleException,
  changeCapacity,
  changeCapacityInput,
  generateSchedule,
  generateScheduleInput,
  getScheduleSetup,
  listCabins,
  previewScheduleException,
  scheduleExceptionInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const scheduleRouter = router({
  setup: procedure('read')
    .input(z.object({ vesselId: z.uuid(), from: date, to: date }))
    .query(({ ctx, input }) => getScheduleSetup(backofficeDb(), ctx.engine, input)),
  /** What a schedule change would touch; runs the change and rolls it back. */
  preview: procedure('schedule.write')
    .input(scheduleExceptionInput)
    .mutation(({ ctx, input }) => previewScheduleException(backofficeDb(), ctx.engine, input)),
  change: procedure('schedule.write')
    .input(scheduleExceptionInput)
    .mutation(({ ctx, input }) => applyScheduleException(backofficeDb(), ctx.engine, input)),
  generate: procedure('schedule.write')
    .input(generateScheduleInput)
    .mutation(({ ctx, input }) => generateSchedule(backofficeDb(), ctx.engine, input)),
  cabins: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => listCabins(backofficeDb(), ctx.engine, input.vesselId)),
  capacity: procedure('inventory.write')
    .input(changeCapacityInput)
    .mutation(({ ctx, input }) => changeCapacity(backofficeDb(), ctx.engine, input)),
});
