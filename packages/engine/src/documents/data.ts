import { sql } from 'kysely';
import type { VsDatabase } from '@vs/db';
import { addDays, type BusinessDate } from '@vs/shared';
import { getLegManifest, type LegManifest } from '../backoffice/manifest';
import { getBookingDetail } from '../backoffice/reads';
import { getAvailability } from '../inventory/availability';
import type { EngineContext } from '../internal';

type Bilingual = { en: string; ar: string };
type BilingualList = { en: string[]; ar: string[] };

export interface BookingDocumentData {
  operator: { name: string; emergencyPhone: string | null; voucherNote: Bilingual };
  booking: {
    ref: string;
    channelRef: string | null;
    channel: string;
    status: string;
    paymentStatus: string;
    market: string;
    currency: string;
    total: bigint;
    fees: bigint;
    amountPaid: bigint;
    penalty: bigint | null;
    createdAt: Date;
  };
  vessel: string;
  sailing: {
    patternCode: string | null;
    name: Bilingual | null;
    nights: number;
    embark: { date: string; port: Bilingual; time: string | null };
    disembark: { date: string; port: Bilingual; time: string | null };
  };
  /** Day by day, from the schedule template: the ports the cruise calls at. */
  days: {
    day: number;
    date: string;
    stops: { port: Bilingual; arrive: string | null; depart: string | null }[];
  }[];
  cabins: {
    index: number;
    category: Bilingual & { code: string };
    cabinNumber: string | null;
    adults: number;
    childAges: number[];
    guests: { name: string; lead: boolean }[];
  }[];
  board: string;
  inclusions: BilingualList;
  exclusions: BilingualList;
  /** Resident and Egyptian rates need ID at embarkation (spec § Pricing). */
  needsResidencyProof: boolean;
  paymentsDue: { kind: 'deposit' | 'balance'; amount: bigint; dueDate: string }[];
  payments: {
    kind: string;
    method: string;
    amount: bigint;
    currency: string;
    reference: string;
    receivedOn: string;
  }[];
  cancellation: { fromDays: number; penaltyBps: number }[];
}

/** Everything a booking document shows, from the booking and its latest policy snapshot. */
export async function bookingDocumentData(
  db: VsDatabase,
  ctx: EngineContext,
  bookingId: string,
): Promise<BookingDocumentData> {
  const ref = await db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) =>
      (
        await tx
          .selectFrom('booking')
          .select('ref')
          .where('id', '=', bookingId)
          .executeTakeFirstOrThrow()
      ).ref,
  );
  const detail = await getBookingDetail(db, ctx, ref);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const operator = await sql<{
      name: string;
      emergency_phone: string | null;
      note_en: string | null;
      note_ar: string | null;
    }>`
      select o.name, s.emergency_phone, s.voucher_note_en as note_en, s.voucher_note_ar as note_ar
      from vs.operator o join vs.operator_setting s on s.operator_id = o.id`.execute(tx);
    const head = await sql<{
      vessel: string;
      market: string;
      needs_proof: boolean;
      pattern_code: string | null;
      name_en: string | null;
      name_ar: string | null;
      nights: number;
      embark_date: string;
      disembark_date: string;
      embark: Bilingual;
      disembark: Bilingual;
      embark_time: string | null;
      disembark_time: string | null;
      snapshot: {
        policies: {
          inclusions?: BilingualList;
          exclusions?: BilingualList;
          rate_plan?: { board?: string };
          cancellation?: { rules: { from_days: number; penalty_bps: number }[] };
        };
      };
    }>`
      select v.name as vessel, b.market,
             coalesce((select m.needs_residency_proof from vs.market m where m.code = b.market),
                      b.market <> 'international') as needs_proof,
             sp.code as pattern_code, sp.name_en, sp.name_ar, s.nights,
             s.embark_date::text, s.disembark_date::text,
             jsonb_build_object('en', ep.name_en, 'ar', ep.name_ar) as embark,
             jsonb_build_object('en', dp.name_en, 'ar', dp.name_ar) as disembark,
             (select to_char(ts.depart_time, 'HH24:MI') from vs.schedule_template_stop ts
              where ts.template_id = sp.template_id and ts.seq = sp.embark_stop_seq) as embark_time,
             (select to_char(ts.arrive_time, 'HH24:MI') from vs.schedule_template_stop ts
              where ts.template_id = sp.template_id and ts.seq = sp.disembark_stop_seq) as disembark_time,
             (select r.snapshot from vs.booking_revision r where r.booking_id = b.id order by r.rev desc limit 1) as snapshot
      from vs.booking b join vs.vessel v on v.id = b.vessel_id
      join vs.sailing s on s.id = b.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      join vs.port ep on ep.id = s.embark_port_id join vs.port dp on dp.id = s.disembark_port_id
      where b.id = ${bookingId}`.execute(tx);
    const stops = await sql<{
      seq: number;
      day_offset: number;
      port: Bilingual;
      arrive: string | null;
      depart: string | null;
      cycle_days: number;
      embark_seq: number;
      disembark_seq: number;
      cycle_offset: number;
    }>`
      select ts.seq, ts.day_offset, jsonb_build_object('en', p.name_en, 'ar', p.name_ar) as port,
             to_char(ts.arrive_time, 'HH24:MI') as arrive, to_char(ts.depart_time, 'HH24:MI') as depart,
             t.cycle_days, sp.embark_stop_seq as embark_seq, sp.disembark_stop_seq as disembark_seq,
             sp.disembark_cycle_offset as cycle_offset
      from vs.booking b join vs.sailing s on s.id = b.sailing_id
      join vs.sailing_pattern sp on sp.id = s.pattern_id
      join vs.schedule_template t on t.id = sp.template_id
      join vs.schedule_template_stop ts on ts.template_id = t.id
      join vs.port p on p.id = ts.port_id
      where b.id = ${bookingId} order by ts.seq`.execute(tx);
    const cabins = await sql<{
      seq: number;
      code: string;
      name_en: string;
      name_ar: string;
      number: string | null;
    }>`
      select bc.seq, c.code, c.name_en, c.name_ar, cab.number
      from vs.booking_cabin bc join vs.cabin_category c on c.id = bc.category_id
      left join vs.cabin cab on cab.id = bc.assigned_cabin_id
      where bc.booking_id = ${bookingId} and bc.status = 'active' order by bc.seq`.execute(tx);
    const h = head.rows[0]!;
    const o = operator.rows[0]!;
    const policies = h.snapshot?.policies ?? {};
    return {
      operator: {
        name: o.name,
        emergencyPhone: o.emergency_phone,
        voucherNote: { en: o.note_en ?? '', ar: o.note_ar ?? '' },
      },
      booking: {
        ref: detail.ref,
        channelRef: detail.channelRef,
        channel: detail.channel.name,
        status: detail.status,
        paymentStatus: detail.paymentStatus,
        market: h.market,
        currency: detail.currency,
        total: detail.total,
        fees: detail.fees,
        amountPaid: detail.amountPaid,
        penalty: detail.penalty,
        createdAt: detail.createdAt,
      },
      vessel: h.vessel,
      sailing: {
        patternCode: h.pattern_code,
        name: h.name_en && h.name_ar ? { en: h.name_en, ar: h.name_ar } : null,
        nights: h.nights,
        embark: { date: h.embark_date, port: h.embark, time: h.embark_time },
        disembark: { date: h.disembark_date, port: h.disembark, time: h.disembark_time },
      },
      days: itineraryDays(stops.rows, h.embark_date),
      cabins: detail.cabins.map((c) => {
        const row = cabins.rows.find((r) => r.seq === c.index);
        return {
          index: c.index,
          category: {
            code: c.categoryCode,
            en: row?.name_en ?? c.categoryCode,
            ar: row?.name_ar ?? c.categoryCode,
          },
          cabinNumber: row?.number ?? null,
          adults: c.adults,
          childAges: c.childAges,
          guests: c.guests.map((g) => ({ name: `${g.firstName} ${g.lastName}`, lead: g.lead })),
        };
      }),
      board: policies.rate_plan?.board ?? 'full_board',
      inclusions: policies.inclusions ?? { en: [], ar: [] },
      exclusions: policies.exclusions ?? { en: [], ar: [] },
      needsResidencyProof: h.needs_proof,
      paymentsDue: detail.paymentsDue,
      payments: detail.payments
        .filter((p) => !p.reversed && p.kind !== 'reversal')
        .map((p) => ({
          kind: p.kind,
          method: p.method,
          amount: p.amount,
          currency: p.currency,
          reference: p.reference,
          receivedOn: p.receivedOn,
        })),
      cancellation: (policies.cancellation?.rules ?? [])
        .map((r) => ({ fromDays: r.from_days, penaltyBps: r.penalty_bps }))
        .sort((a, b) => b.fromDays - a.fromDays),
    };
  });
}

/**
 * Walks the template from the embark stop to the disembark stop (into the next cycle when the
 * cruise wraps round) and groups the calls by cruise day. A stop that ends one cycle and starts
 * the next is the same call and is listed once.
 */
function itineraryDays(
  stops: {
    seq: number;
    day_offset: number;
    port: Bilingual;
    arrive: string | null;
    depart: string | null;
    cycle_days: number;
    embark_seq: number;
    disembark_seq: number;
    cycle_offset: number;
  }[],
  embarkDate: string,
): BookingDocumentData['days'] {
  const first = stops[0];
  if (!first) return [];
  const calls: { offset: number; stop: (typeof stops)[number] }[] = [];
  for (let cycle = 0; cycle <= first.cycle_offset; cycle += 1) {
    for (const stop of stops) {
      if (cycle === 0 && stop.seq < first.embark_seq) continue;
      if (cycle === first.cycle_offset && stop.seq > first.disembark_seq) continue;
      const offset = stop.day_offset + cycle * first.cycle_days;
      const previous = calls.at(-1);
      if (previous && previous.offset === offset && previous.stop.port.en === stop.port.en)
        continue;
      calls.push({ offset, stop });
    }
  }
  const start = calls[0]?.offset ?? 0;
  const days = new Map<number, BookingDocumentData['days'][number]>();
  for (const { offset, stop } of calls) {
    const day = offset - start + 1;
    const entry = days.get(day) ?? {
      day,
      date: addDays(embarkDate as BusinessDate, day - 1),
      stops: [],
    };
    entry.stops.push({ port: stop.port, arrive: stop.arrive, depart: stop.depart });
    days.set(day, entry);
  }
  return [...days.values()];
}

export interface VacancyData {
  operator: string;
  vessel: string;
  from: string;
  to: string;
  categories: { id: string; code: string; en: string; ar: string }[];
  sailings: {
    embarkDate: string;
    disembarkDate: string;
    patternCode: string | null;
    nights: number;
    embark: Bilingual;
    disembark: Bilingual;
    free: Record<string, number>;
  }[];
}

/** The weekly vacancy sheet: free cabins per sailing and category for the coming weeks. */
export async function vacancyData(
  db: VsDatabase,
  ctx: EngineContext,
  input: { vesselId: string; from: string; weeks: number },
): Promise<VacancyData> {
  const to = addDays(input.from as BusinessDate, input.weeks * 7 - 1);
  const availability = await getAvailability(db, ctx, {
    vesselId: input.vesselId,
    from: input.from,
    to,
  });
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessel = await tx
      .selectFrom('vessel as v')
      .innerJoin('operator as o', 'o.id', 'v.operator_id')
      .select(['v.name', 'o.name as operator'])
      .where('v.id', '=', input.vesselId)
      .executeTakeFirstOrThrow();
    const categories = await tx
      .selectFrom('cabin_category')
      .select(['id', 'code', 'name_en as en', 'name_ar as ar'])
      .where('vessel_id', '=', input.vesselId)
      .orderBy('sort_order')
      .execute();
    const ports = await tx.selectFrom('port').select(['code', 'name_en', 'name_ar']).execute();
    const port = (code: string) => {
      const p = ports.find((x) => x.code === code);
      return { en: p?.name_en ?? code, ar: p?.name_ar ?? code };
    };
    return {
      operator: vessel.operator,
      vessel: vessel.name,
      from: input.from,
      to,
      categories,
      sailings: availability.sailings.map((s) => ({
        embarkDate: s.embarkDate,
        disembarkDate: s.disembarkDate,
        patternCode: s.patternCode,
        nights: s.nights,
        embark: port(s.embarkPort),
        disembark: port(s.disembarkPort),
        free: Object.fromEntries(s.categories.map((c) => [c.categoryId, c.free])),
      })),
    };
  });
}

export interface OutagePackData {
  vacancy: VacancyData;
  /** Who is aboard each departure in the period: names and cabins, no passport numbers. */
  manifests: LegManifest[];
  opsEmail: string | null;
}

/** The nightly fallback (spec § Availability): 14 days of availability and departure manifests. */
export async function outagePackData(
  db: VsDatabase,
  ctx: EngineContext,
  input: { vesselId: string; from: string },
): Promise<OutagePackData> {
  const vacancy = await vacancyData(db, ctx, {
    vesselId: input.vesselId,
    from: input.from,
    weeks: 2,
  });
  const { legIds, opsEmail } = await db.withTenantTx(
    ctx.operatorId,
    ctx.actor,
    async ({ db: tx }) => {
      const legs = await tx
        .selectFrom('leg')
        .select('id')
        .where('vessel_id', '=', input.vesselId)
        .where('status', '=', 'open')
        .where('depart_date', '>=', input.from)
        .where('depart_date', '<=', vacancy.to)
        .orderBy('depart_date')
        .execute();
      const settings = await tx
        .selectFrom('operator_setting')
        .select('ops_email')
        .executeTakeFirstOrThrow();
      return { legIds: legs.map((l) => l.id), opsEmail: settings.ops_email };
    },
  );
  const manifests: LegManifest[] = [];
  for (const legId of legIds) manifests.push(await getLegManifest(db, ctx, legId));
  return { vacancy, manifests, opsEmail };
}

/** Vessels whose outage pack goes out tonight: every active vessel of the company. */
export async function activeVesselIds(db: VsDatabase, ctx: EngineContext): Promise<string[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) =>
    (await tx.selectFrom('vessel').select('id').where('active', '=', true).execute()).map(
      (v) => v.id,
    ),
  );
}
