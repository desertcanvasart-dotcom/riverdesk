import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { mulDivHalfUp } from '@vs/shared';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { createQuote, useQuote, type Quote } from '../pricing/quote';
import { dateSchema } from '../schedule/setup';
import { daysBeforeEmbark, latestPolicies, penaltyBps } from './cancel';
import {
  auditBooking,
  bookingEvent,
  requestKeySchema,
  sailingLegs,
  withRequestKey,
  writeRevision,
  type QuotedCabin,
} from './common';
import { loadContract } from './holds';
import { renumberCabins } from './requests';
import { releaseUnits, takeUnits } from './units';

const cabinSchema = z.object({
  categoryId: z.uuid(),
  adults: z.number().int().min(0).max(10),
  childAges: z.array(z.number().int().min(0).max(17)).default([]),
  childBirthDates: z.array(dateSchema).default([]),
});

export const quoteAmendmentInput = z.object({
  bookingId: z.uuid(),
  /** Omit to keep the current sailing. */
  sailingId: z.uuid().optional(),
  /** The full set of cabins after the change; omit to keep the current cabins. */
  cabins: z.array(cabinSchema).min(1).max(20).optional(),
});

interface FeeRule {
  change_kind: string;
  from_days: number;
  fee_kind: string;
  amount: string | null;
  currency: string | null;
  percent_bps: number | null;
}

export type ChangeKind = 'date' | 'category' | 'occupancy' | 'cabins';

/**
 * Amendment fee from the booking's policy snapshot: the highest matching amendment-fee rule, plus
 * — when the new total is lower inside a penalty window — the cancellation penalty on the
 * reduction (removed nights or cabins are charged as a cancellation, spec § Amendments).
 */
export function amendmentFee(options: {
  policies: {
    amendment_fees?: FeeRule[];
    cancellation: { rules: { from_days: number; penalty_bps: number }[] };
  };
  changes: ChangeKind[];
  days: number;
  oldTotal: bigint;
  newTotal: bigint;
  currency: string;
}): bigint {
  let ruleFee = 0n;
  for (const rule of options.policies.amendment_fees ?? []) {
    if (rule.from_days > Math.max(options.days, 0) && rule.from_days !== 0) continue;
    if (rule.change_kind !== 'any' && !options.changes.includes(rule.change_kind as ChangeKind))
      continue;
    const fee =
      rule.fee_kind === 'flat'
        ? rule.currency === options.currency
          ? BigInt(rule.amount ?? '0')
          : 0n
        : mulDivHalfUp(options.newTotal, BigInt(rule.percent_bps ?? 0), 10_000n);
    if (fee > ruleFee) ruleFee = fee;
  }
  const reduction = options.oldTotal > options.newTotal ? options.oldTotal - options.newTotal : 0n;
  const reductionPenalty = mulDivHalfUp(
    reduction,
    BigInt(penaltyBps(options.policies, options.days)),
    10_000n,
  );
  return ruleFee + reductionPenalty;
}

function detectChanges(
  oldSailing: string,
  newSailing: string,
  oldCabins: QuotedCabin[],
  newCabins: QuotedCabin[],
): ChangeKind[] {
  const changes = new Set<ChangeKind>();
  if (oldSailing !== newSailing) changes.add('date');
  if (oldCabins.length !== newCabins.length) changes.add('cabins');
  const key = (cabins: QuotedCabin[]) =>
    cabins
      .map((c) => c.categoryId)
      .sort()
      .join(',');
  if (key(oldCabins) !== key(newCabins)) changes.add('category');
  // Occupancy: a cabin present in both versions (same index) with other adults or child ages.
  const occupancy = (c: QuotedCabin) =>
    `${c.adults}:${[...c.childAges].sort((a, b) => a - b).join('.')}`;
  for (let i = 0; i < Math.min(oldCabins.length, newCabins.length); i += 1) {
    if (occupancy(oldCabins[i]!) !== occupancy(newCabins[i]!)) changes.add('occupancy');
  }
  return [...changes];
}

async function activeCabins(
  tx: Tx,
  bookingId: string,
): Promise<(QuotedCabin & { id: string; seq: number })[]> {
  const rows = await tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq', 'category_id', 'adults', 'child_ages'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .orderBy('seq')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    categoryId: r.category_id,
    adults: r.adults,
    childAges: r.child_ages,
  }));
}

async function feeFor(
  tx: Tx,
  booking: { id: string; sailing_id: string; total: bigint; currency: string },
  quote: Quote,
) {
  const cabins = await activeCabins(tx, booking.id);
  const changes = detectChanges(
    booking.sailing_id,
    quote.sailingId,
    cabins,
    quote.cabins as QuotedCabin[],
  );
  const days = await daysBeforeEmbark(tx, booking.sailing_id);
  const policies = (await latestPolicies(tx, booking.id)) as Parameters<
    typeof amendmentFee
  >[0]['policies'];
  return {
    changes,
    fee: amendmentFee({
      policies,
      changes,
      days,
      oldTotal: booking.total,
      newTotal: quote.total,
      currency: booking.currency,
    }),
  };
}

/** Prices a proposed change as a new quote, with the fee it would carry. Changes nothing. */
export async function quoteAmendment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof quoteAmendmentInput>,
) {
  const data = parseInput(quoteAmendmentInput, input);
  const booking = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const b = await tx
      .selectFrom('booking')
      .selectAll()
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!b) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    if (b.status !== 'confirmed')
      throw new DomainError('INVALID_STATE', { message: 'Only confirmed bookings can be amended' });
    return { ...b, cabins: await activeCabins(tx, b.id) };
  });
  const quote = await createQuote(db, ctx, {
    channelId: booking.channel_id,
    sailingId: data.sailingId ?? booking.sailing_id,
    market: booking.market,
    ratePlanId: booking.rate_plan_id,
    cabins:
      data.cabins ??
      booking.cabins.map((c) => ({
        categoryId: c.categoryId,
        adults: c.adults,
        childAges: c.childAges,
      })),
  });
  const { changes, fee } = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    feeFor(tx, booking, quote),
  );
  return {
    quote,
    revision: booking.revision,
    changes,
    fee,
    difference: quote.total - booking.total,
  };
}

export const applyAmendmentInput = z.object({
  bookingId: z.uuid(),
  /** The revision the client is amending (If-Match); a stale one is REVISION_CHANGED. */
  revision: z.number().int().min(1),
  amendmentQuoteId: z.uuid(),
  requestKey: requestKeySchema,
});

/**
 * One transaction (spec § Amendments): the required cabins per leg × category of the new
 * version against the current booking lines; acquire every increase first (booked += n,
 * conditional), then release every decrease; lines on unchanged legs keep their bucket. If any
 * acquisition fails, nothing changes.
 */
export async function applyAmendment(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof applyAmendmentInput>,
) {
  const data = parseInput(applyAmendmentInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const peek = await tx
      .selectFrom('booking')
      .select(['channel_id'])
      .where('id', '=', data.bookingId)
      .executeTakeFirst();
    if (!peek) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    return withRequestKey(
      tx,
      ctx,
      { scopeId: peek.channel_id, key: data.requestKey, action: 'booking.amend', input: data },
      async () => {
        // Guard on the owning row: confirmed and at the revision the client saw.
        const booking = await tx
          .updateTable('booking')
          .set((eb) => ({ revision: eb('revision', '+', 1) }))
          .where('id', '=', data.bookingId)
          .where('status', '=', 'confirmed')
          .where('revision', '=', data.revision)
          .returningAll()
          .executeTakeFirst();
        if (!booking) {
          const current = await tx
            .selectFrom('booking')
            .select(['status', 'revision'])
            .where('id', '=', data.bookingId)
            .executeTakeFirstOrThrow();
          if (current.status === 'confirmed')
            throw new DomainError('REVISION_CHANGED', { details: { revision: current.revision } });
          throw new DomainError('INVALID_STATE', {
            message: `Only confirmed bookings can be amended (this one is ${current.status})`,
          });
        }
        const before = { ...booking, revision: booking.revision - 1 };
        const quote = await useQuote(tx, data.amendmentQuoteId, booking.channel_id);
        const contract = await loadContract(tx, quote.contractId);
        const newLegs = await sailingLegs(tx, quote.sailingId);
        const sailing = await tx
          .selectFrom('sailing')
          .select('status')
          .where('id', '=', quote.sailingId)
          .executeTakeFirstOrThrow();
        if (sailing.status !== 'open' || newLegs.some((l) => l.status !== 'open'))
          throw new DomainError('SAILING_CLOSED');
        const { changes, fee } = await feeFor(tx, before, quote);

        const newCabins = quote.cabins as QuotedCabin[];
        const oldLines = await tx
          .selectFrom('booking_line')
          .select(['id', 'leg_id', 'category_id', 'bucket_id'])
          .where('booking_id', '=', booking.id)
          .where('status', '=', 'confirmed')
          .orderBy('id')
          .execute();
        const key = (legId: string, categoryId: string) => `${legId}|${categoryId}`;
        const required = new Map<string, number>();
        for (const leg of newLegs)
          for (const cabin of newCabins)
            required.set(
              key(leg.id, cabin.categoryId),
              (required.get(key(leg.id, cabin.categoryId)) ?? 0) + 1,
            );
        const current = new Map<string, typeof oldLines>();
        for (const line of oldLines)
          current.set(key(line.leg_id, line.category_id), [
            ...(current.get(key(line.leg_id, line.category_id)) ?? []),
            line,
          ]);

        // 1. Acquire every increase first.
        const increases = [...required]
          .map(([k, n]) => ({ k, n: n - (current.get(k)?.length ?? 0) }))
          .filter((x) => x.n > 0)
          .map(({ k, n }) => ({ legId: k.split('|')[0]!, categoryId: k.split('|')[1]!, n }));
        const taken = await takeUnits(tx, ctx, {
          channelId: booking.channel_id,
          allocation: contract.allocation,
          needs: increases,
          field: 'booked',
          cause: 'booking.amended',
          ref: { entity: 'booking', id: booking.id },
        });

        // 2. Then release every decrease.
        const releasing: typeof oldLines = [];
        for (const [k, lines] of current) {
          const surplus = lines.length - (required.get(k) ?? 0);
          if (surplus > 0) releasing.push(...lines.slice(lines.length - surplus));
        }
        if (releasing.length > 0) {
          await tx
            .updateTable('booking_line')
            .set({ status: 'released', released_at: sql<Date>`now()` })
            .where(
              'id',
              'in',
              releasing.map((l) => l.id),
            )
            .execute();
          await releaseUnits(
            tx,
            ctx,
            releasing.map((l) => ({ bucketId: l.bucket_id, n: 1, field: 'booked' as const })),
            'booking.amended',
            { entity: 'booking', id: booking.id },
          );
        }

        // 3. Cabins become the new version; kept lines move to the new cabins, new lines are added.
        const cabins = await reshapeCabins(tx, ctx, booking.id, newCabins);
        const kept = oldLines.filter((l) => !releasing.some((r) => r.id === l.id));
        const takenBucket = new Map(taken.map((t) => [key(t.legId, t.categoryId), t.bucketId]));
        const newLineRows = [];
        for (const leg of newLegs) {
          const pool = kept.filter((l) => l.leg_id === leg.id);
          for (const cabin of cabins) {
            const reuse = pool.findIndex((l) => l.category_id === cabin.category_id);
            if (reuse >= 0) {
              const [line] = pool.splice(reuse, 1);
              await tx
                .updateTable('booking_line')
                .set({ booking_cabin_id: cabin.id })
                .where('id', '=', line!.id)
                .execute();
            } else {
              const bucketId = takenBucket.get(key(leg.id, cabin.category_id));
              if (!bucketId)
                throw new DomainError('INVARIANT_VIOLATION', {
                  details: { reason: 'amendment line without bucket', legId: leg.id },
                });
              newLineRows.push({
                operator_id: ctx.operatorId,
                booking_id: booking.id,
                booking_cabin_id: cabin.id,
                leg_id: leg.id,
                category_id: cabin.category_id,
                bucket_id: bucketId,
              });
            }
          }
        }
        if (newLineRows.length > 0)
          await tx.insertInto('booking_line').values(newLineRows).execute();

        await tx
          .updateTable('booking')
          .set({
            sailing_id: quote.sailingId,
            quote_id: quote.id,
            rate_plan_id: quote.ratePlanId,
            currency: quote.currency,
            total: quote.total,
            net_total: quote.netTotal,
          })
          .where('id', '=', booking.id)
          .execute();
        await writeRevision(tx, ctx, {
          bookingId: booking.id,
          rev: booking.revision,
          quote,
          reason: `amendment: ${changes.join(', ') || 'repriced'}`,
          fee,
          extra: { changes },
        });
        await bookingEvent(tx, ctx, booking.id, 'booking.amended', {
          changes,
          total: quote.total.toString(),
          fee: fee.toString(),
          currency: quote.currency,
        });
        await auditBooking(
          tx,
          ctx,
          'booking.amended',
          booking.id,
          { revision: before.revision, sailing_id: before.sailing_id, total: before.total },
          {
            revision: booking.revision,
            sailing_id: quote.sailingId,
            total: quote.total,
            fee,
            changes,
          },
        );
        return {
          bookingId: booking.id,
          revision: booking.revision,
          total: quote.total,
          fee,
          changes,
        };
      },
    );
  });
}

/** Updates cabins in place where the index survives, adds new ones, cancels the rest. */
async function reshapeCabins(tx: Tx, ctx: EngineContext, bookingId: string, cabins: QuotedCabin[]) {
  const old = await activeCabins(tx, bookingId);
  for (const [i, cabin] of cabins.entries()) {
    const existing = old[i];
    if (existing) {
      await tx
        .updateTable('booking_cabin')
        .set({
          category_id: cabin.categoryId,
          adults: cabin.adults,
          child_ages: cabin.childAges,
          ...(existing.categoryId !== cabin.categoryId ? { assigned_cabin_id: null } : {}),
        })
        .where('id', '=', existing.id)
        .execute();
    } else {
      await tx
        .insertInto('booking_cabin')
        .values({
          operator_id: ctx.operatorId,
          booking_id: bookingId,
          seq: 1000 + i,
          category_id: cabin.categoryId,
          adults: cabin.adults,
          child_ages: cabin.childAges,
        })
        .execute();
    }
  }
  const surplus = old.slice(cabins.length);
  if (surplus.length > 0) {
    const first = old[0]!;
    await tx
      .updateTable('guest')
      .set({ booking_cabin_id: first.id })
      .where(
        'booking_cabin_id',
        'in',
        surplus.map((c) => c.id),
      )
      .execute();
    await tx
      .updateTable('booking_cabin')
      .set({ status: 'cancelled' })
      .where(
        'id',
        'in',
        surplus.map((c) => c.id),
      )
      .execute();
  }
  await renumberCabins(tx, bookingId);
  return tx
    .selectFrom('booking_cabin')
    .select(['id', 'seq', 'category_id'])
    .where('booking_id', '=', bookingId)
    .where('status', '=', 'active')
    .orderBy('seq')
    .execute();
}
