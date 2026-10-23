import { z } from 'zod';
import type { VsDatabase } from '@vs/db';
import { confirmHold, createHold, releaseHold } from '../booking/holds';
import { guestSchema } from '../booking/common';
import { createRequest } from '../booking/requests';
import { parseInput, type EngineContext } from '../internal';
import { createQuote, priceSailingInput } from '../pricing/quote';

export const staffBookInput = priceSailingInput.extend({
  guests: z.array(guestSchema).min(1),
  channelRef: z.string().min(1).max(100).optional(),
  /** One key per submission; each step derives its own from it, so a repeat replays every step. */
  requestKey: z.string().min(8).max(200),
});

/**
 * The fast phone booking: quote → option hold → confirm, or quote → request when the contract is
 * on request. Each step is its own engine call with its own request key, so a double click (or a
 * retry after a timeout) returns the same booking instead of a second one.
 */
export async function staffBook(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof staffBookInput>,
) {
  const { guests, channelRef, requestKey, ...pricing } = parseInput(staffBookInput, input);
  const quote = await createQuote(db, ctx, pricing, { requestKey: `${requestKey}:quote` });
  const onRequest = await db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) =>
      (
        await tx
          .selectFrom('channel_contract')
          .select('allocation')
          .where('id', '=', quote.contractId)
          .executeTakeFirstOrThrow()
      ).allocation === 'on_request',
  );
  if (onRequest) {
    const request = await createRequest(db, ctx, {
      channelId: pricing.channelId,
      quoteId: quote.id,
      channelRef,
      guests,
      requestKey: `${requestKey}:request`,
    });
    return {
      bookingId: request.bookingId,
      ref: request.ref,
      status: request.status,
      total: quote.total,
      currency: quote.currency,
    };
  }
  const hold = await createHold(db, ctx, {
    channelId: pricing.channelId,
    quoteId: quote.id,
    kind: 'option',
    requestKey: `${requestKey}:hold`,
  });
  const booking = await confirmHold(db, ctx, {
    holdId: hold.holdId,
    guests,
    channelRef,
    requestKey: `${requestKey}:confirm`,
  }).catch(async (error: unknown) => {
    // Do not leave an option hold behind when the confirmation is refused.
    await releaseHold(db, ctx, { holdId: hold.holdId, requestKey: `${requestKey}:release` }).catch(
      () => undefined,
    );
    throw error;
  });
  return { ...booking, total: quote.total, currency: quote.currency };
}
