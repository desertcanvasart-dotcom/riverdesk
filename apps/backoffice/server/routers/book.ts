import { z } from 'zod';
import {
  channelAvailability,
  listBookableChannels,
  listVessels,
  priceSailing,
  priceSailingInput,
  staffBook,
  staffBookInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The fast phone booking: pick a sailing, cabins and the guest, see the total live, confirm. */
export const bookRouter = router({
  vessels: procedure('read').query(({ ctx }) => listVessels(backofficeDb(), ctx.engine)),
  channels: procedure('read')
    .input(z.object({ vesselId: z.uuid() }))
    .query(({ ctx, input }) => listBookableChannels(backofficeDb(), ctx.engine, input.vesselId)),
  availability: procedure('read')
    .input(z.object({ channelId: z.uuid(), vesselId: z.uuid(), from: date, to: date }))
    .query(({ ctx, input }) => channelAvailability(backofficeDb(), ctx.engine, input)),
  price: procedure('read')
    .input(priceSailingInput)
    .query(({ ctx, input }) => priceSailing(backofficeDb(), ctx.engine, input)),
  create: procedure('bookings.write')
    .input(staffBookInput)
    .mutation(({ ctx, input }) => staffBook(backofficeDb(), ctx.engine, input)),
});
