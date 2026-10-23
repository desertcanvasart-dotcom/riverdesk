import {
  acceptRequest,
  acceptRequestInput,
  createQuote,
  declineRequest,
  declineRequestInput,
  listRequests,
  offerAlternative,
  priceSailingInput,
} from '@vs/engine';
import { z } from 'zod';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

export const requestsRouter = router({
  list: procedure('read').query(({ ctx }) => listRequests(backofficeDb(), ctx.engine)),
  accept: procedure('bookings.write')
    .input(acceptRequestInput)
    .mutation(({ ctx, input }) => acceptRequest(backofficeDb(), ctx.engine, input)),
  decline: procedure('bookings.write')
    .input(declineRequestInput)
    .mutation(({ ctx, input }) => declineRequest(backofficeDb(), ctx.engine, input)),
  /** Prices the alternative sailing for the requesting channel, then offers it. */
  offer: procedure('bookings.write')
    .input(
      priceSailingInput.extend({ bookingId: z.uuid(), requestKey: z.string().min(8).max(200) }),
    )
    .mutation(async ({ ctx, input }) => {
      const { bookingId, requestKey, ...pricing } = input;
      const quote = await createQuote(backofficeDb(), ctx.engine, pricing, {
        requestKey: `${requestKey}:quote`,
      });
      return offerAlternative(backofficeDb(), ctx.engine, {
        bookingId,
        quoteId: quote.id,
        requestKey: `${requestKey}:offer`,
      });
    }),
});
