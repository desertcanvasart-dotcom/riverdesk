import { sql } from 'kysely';
import { isDomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { decimalToMinor, minorToDecimal } from '@vs/shared';
import { recordPayment } from '../booking/payments';
import { cairoToday, type EngineContext } from '../internal';
import { priceSailing } from '../pricing/quote';
import { staffBook } from './book';

/**
 * Pilot import (Batch 7): the vessel's existing future bookings, one CSV row per cabin, rows of
 * one booking sharing `external_ref`. Every booking goes through the engine like a back-office
 * booking (rule 1). Re-runnable: the request key is derived from the external reference, so a
 * second run returns the bookings already made. Conflicts are reported, never forced.
 */

export const IMPORT_COLUMNS = [
  'external_ref',
  'channel_code',
  'vessel_code',
  'itinerary',
  'embark_date',
  'market',
  'category_code',
  'adults',
  'child_ages',
  'guests',
  'nationality',
  'expected_total',
  'paid_amount',
  'paid_reference',
] as const;

export type ImportRow = Record<(typeof IMPORT_COLUMNS)[number], string>;

export interface ImportResult {
  externalRef: string;
  outcome: 'created' | 'already_imported' | 'would_create' | 'conflict' | 'invalid';
  ref?: string;
  status?: string;
  message?: string;
  warnings: string[];
}

export async function importBookings(
  db: VsDatabase,
  ctx: EngineContext,
  rows: ImportRow[],
  options: { dryRun?: boolean } = {},
): Promise<ImportResult[]> {
  const byRef = new Map<string, ImportRow[]>();
  for (const row of rows) {
    const key = row.external_ref?.trim();
    if (!key) continue;
    byRef.set(key, [...(byRef.get(key) ?? []), row]);
  }
  const lookups = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => ({
    today: await cairoToday(tx),
    channels: await tx.selectFrom('channel').select(['id', 'code', 'type']).execute(),
    vessels: await tx.selectFrom('vessel').select(['id', 'code']).execute(),
    categories: await tx.selectFrom('cabin_category').select(['id', 'code', 'vessel_id']).execute(),
  }));

  const results: ImportResult[] = [];
  for (const [externalRef, cabins] of byRef) {
    const first = cabins[0]!;
    const warnings: string[] = [];
    const invalid = (message: string) =>
      results.push({ externalRef, outcome: 'invalid', message, warnings });
    const channel = first.channel_code
      ? lookups.channels.find((c) => c.code === first.channel_code.trim())
      : lookups.channels.find((c) => c.type === 'back_office');
    if (!channel) {
      invalid(`Unknown channel ${first.channel_code}`);
      continue;
    }
    const vessel = lookups.vessels.find((v) => v.code === first.vessel_code.trim());
    if (!vessel) {
      invalid(`Unknown vessel ${first.vessel_code}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first.embark_date.trim())) {
      invalid(`Embark date must be YYYY-MM-DD, got ${first.embark_date}`);
      continue;
    }
    if (first.embark_date.trim() <= lookups.today) {
      invalid('Only future bookings are imported');
      continue;
    }
    const previous = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
      tx
        .selectFrom('booking')
        .select(['ref', 'status'])
        .where('channel_id', '=', channel.id)
        .where('channel_ref', '=', externalRef)
        .executeTakeFirst(),
    );
    if (previous) {
      results.push({
        externalRef,
        outcome: 'already_imported',
        ref: previous.ref,
        status: previous.status,
        warnings,
      });
      continue;
    }
    const sailing = await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
      sql<{ id: string }>`
        select s.id from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id
        where s.vessel_id = ${vessel.id} and sp.code = ${first.itinerary.trim()} and s.embark_date = ${first.embark_date.trim()}::date`
        .execute(tx)
        .then((r) => r.rows[0]),
    );
    if (!sailing) {
      results.push({
        externalRef,
        outcome: 'conflict',
        message: `No ${first.itinerary} sailing on ${first.embark_date}`,
        warnings,
      });
      continue;
    }
    const parsed: { categoryId: string; adults: number; childAges: number[] }[] = [];
    const guests: {
      cabin: number;
      firstName: string;
      lastName: string;
      nationality?: string;
      lead: boolean;
    }[] = [];
    let problem: string | null = null;
    cabins.forEach((row, index) => {
      const category = lookups.categories.find(
        (c) => c.vessel_id === vessel.id && c.code === row.category_code.trim(),
      );
      const adults = Number(row.adults);
      const ages = row.child_ages.trim() ? row.child_ages.split(/[;,\s]+/).map(Number) : [];
      if (!category) problem ??= `Unknown category ${row.category_code}`;
      else if (!Number.isInteger(adults) || adults < 1)
        problem ??= `Adults must be 1 or more (cabin ${index + 1})`;
      else if (ages.some((a) => !Number.isInteger(a) || a < 0 || a > 17))
        problem ??= `Bad child ages "${row.child_ages}"`;
      else parsed.push({ categoryId: category.id, adults, childAges: ages });
      for (const name of row.guests
        .split('|')
        .map((n) => n.trim())
        .filter(Boolean)) {
        const [firstName, ...rest] = name.split(/\s+/);
        guests.push({
          cabin: index,
          firstName: firstName!,
          lastName: rest.join(' ') || '-',
          nationality: /^[A-Z]{2}$/.test(row.nationality.trim())
            ? row.nationality.trim()
            : undefined,
          lead: guests.length === 0,
        });
      }
    });
    if (problem) {
      invalid(problem);
      continue;
    }
    if (guests.length === 0) {
      invalid('At least the lead guest name is needed');
      continue;
    }
    const pricing = {
      channelId: channel.id,
      sailingId: sailing.id,
      market: first.market.trim() || 'international',
      cabins: parsed,
    };
    try {
      const price = await priceSailing(db, ctx, pricing);
      const expected = first.expected_total.trim()
        ? decimalToMinor(first.expected_total, price.currency)
        : null;
      if (expected !== null && expected !== price.total) {
        warnings.push(
          `Price differs: imported ${first.expected_total}, today's rates ${minorToDecimal(price.total, price.currency)}`,
        );
      }
      if (options.dryRun) {
        results.push({ externalRef, outcome: 'would_create', warnings });
        continue;
      }
      const booked = await staffBook(db, ctx, {
        ...pricing,
        guests,
        channelRef: externalRef,
        requestKey: `import:${externalRef}`,
      });
      let status = booked.status;
      const paid = first.paid_amount.trim()
        ? decimalToMinor(first.paid_amount, price.currency)
        : null;
      if (paid !== null && paid > 0n) {
        const payment = await recordPayment(db, ctx, {
          bookingId: booked.bookingId,
          kind: 'payment',
          method: 'bank_transfer',
          amount: paid,
          currency: booked.currency as 'USD',
          reference: first.paid_reference.trim() || `import ${externalRef}`,
          receivedOn: lookups.today,
          requestKey: `import:${externalRef}:payment`,
        });
        status = payment.bookingStatus ?? status;
      }
      if (status === 'held')
        warnings.push('Waiting for its deposit: record the payment before the hold runs out');
      results.push({ externalRef, outcome: 'created', ref: booked.ref, status, warnings });
    } catch (error) {
      if (!isDomainError(error)) throw error;
      results.push({
        externalRef,
        outcome: 'conflict',
        message: `${error.code}: ${error.message}`,
        warnings,
      });
    }
  }
  return results;
}

/** RFC 4180-style CSV (quoted fields, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): ImportRow[] {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      if (record.some((f) => f.trim())) records.push(record);
      record = [];
      field = '';
    } else field += ch;
  }
  record.push(field);
  if (record.some((f) => f.trim())) records.push(record);
  const [header, ...body] = records;
  if (!header) return [];
  const names = header.map((h) => h.trim().replace(/^\uFEFF/, ''));
  const missing = IMPORT_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length) throw new Error(`Missing columns: ${missing.join(', ')}`);
  return body
    .filter((r) => !r[0]?.trim().startsWith('#'))
    .map(
      (r) =>
        Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, r[names.indexOf(c)] ?? ''])) as ImportRow,
    );
}
