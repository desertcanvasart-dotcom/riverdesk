import { z } from 'zod';
import {
  applyAmendment,
  applyAmendmentInput,
  cancelBooking,
  cancelBookingInput,
  eraseGuest,
  exportGuestData,
  guestRequestInput,
  getBookingDetail,
  previewCancellation,
  quoteAmendment,
  quoteAmendmentInput,
  searchBookings,
  upsertGuests,
  upsertGuestsInput,
} from '@vs/engine';
import { backofficeDb } from '../db';
import { procedure, router } from '../trpc';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const bookingsRouter = router({
  search: procedure('read')
    .input(
      z.object({
        q: z.string().max(100).optional(),
        status: z.string().max(30).optional(),
        from: date.optional(),
        to: date.optional(),
      }),
    )
    .query(({ ctx, input }) => searchBookings(backofficeDb(), ctx.engine, input)),
  detail: procedure('read')
    .input(z.object({ ref: z.string().min(1).max(40) }))
    .query(({ ctx, input }) => getBookingDetail(backofficeDb(), ctx.engine, input.ref)),
  cancelPreview: procedure('read')
    .input(z.object({ bookingId: z.uuid() }))
    .query(({ ctx, input }) => previewCancellation(backofficeDb(), ctx.engine, input.bookingId)),
  cancel: procedure('bookings.write')
    .input(cancelBookingInput)
    .mutation(({ ctx, input }) => cancelBooking(backofficeDb(), ctx.engine, input)),
  quoteAmendment: procedure('bookings.write')
    .input(quoteAmendmentInput)
    .mutation(({ ctx, input }) => quoteAmendment(backofficeDb(), ctx.engine, input)),
  applyAmendment: procedure('bookings.write')
    .input(applyAmendmentInput)
    .mutation(({ ctx, input }) => applyAmendment(backofficeDb(), ctx.engine, input)),
  exportGuest: procedure('guests.privacy')
    .input(guestRequestInput)
    .mutation(({ ctx, input }) => exportGuestData(backofficeDb(), ctx.engine, input)),
  eraseGuest: procedure('guests.privacy')
    .input(guestRequestInput)
    .mutation(({ ctx, input }) => eraseGuest(backofficeDb(), ctx.engine, input)),
  guests: procedure('bookings.write')
    .input(upsertGuestsInput)
    .mutation(({ ctx, input }) => upsertGuests(backofficeDb(), ctx.engine, input)),
});
