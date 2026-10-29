import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { addDays, type BusinessDate } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';
import { dateSchema } from '../schedule/setup';

/**
 * On-board operations (Batch D3, docs/documents-plan.md § 5): what the daily programme and the
 * guest's pre-departure sheet are built from — each vessel's day (boarding, meals, luggage,
 * check-out), where it berths and what guests visit at each port, and the company's own
 * pre-departure wording. Everything is optional; documents leave out what is not set, and the
 * pre-departure sheet uses standard wording where the company has none.
 */

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM')
  .nullable();
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => (v ? v : null));

const VESSEL_TIMES = {
  boardingTime: 'boarding_time',
  breakfastTime: 'breakfast_time',
  lunchTime: 'lunch_time',
  teaTime: 'tea_time',
  dinnerTime: 'dinner_time',
  luggageTime: 'luggage_time',
  checkoutTime: 'checkout_time',
} as const;

export interface VesselDay {
  id: string;
  name: string;
  boardingTime: string | null;
  breakfastTime: string | null;
  lunchTime: string | null;
  teaTime: string | null;
  dinnerTime: string | null;
  luggageTime: string | null;
  checkoutTime: string | null;
  programmeNoteAr: string | null;
  programmeNoteEn: string | null;
}

export interface PortGuide {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  berthAr: string | null;
  berthEn: string | null;
  visitsAr: string | null;
  visitsEn: string | null;
}

export interface GuestInfoTexts {
  whatToBringAr: string | null;
  whatToBringEn: string | null;
  dressCodeAr: string | null;
  dressCodeEn: string | null;
  documentsAr: string | null;
  documentsEn: string | null;
}

async function loadVessels(tx: Tx, vesselId?: string): Promise<VesselDay[]> {
  let query = tx
    .selectFrom('vessel')
    .select([
      'id',
      'name',
      sql<string | null>`to_char(boarding_time, 'HH24:MI')`.as('boardingTime'),
      sql<string | null>`to_char(breakfast_time, 'HH24:MI')`.as('breakfastTime'),
      sql<string | null>`to_char(lunch_time, 'HH24:MI')`.as('lunchTime'),
      sql<string | null>`to_char(tea_time, 'HH24:MI')`.as('teaTime'),
      sql<string | null>`to_char(dinner_time, 'HH24:MI')`.as('dinnerTime'),
      sql<string | null>`to_char(luggage_time, 'HH24:MI')`.as('luggageTime'),
      sql<string | null>`to_char(checkout_time, 'HH24:MI')`.as('checkoutTime'),
      'programme_note_ar as programmeNoteAr',
      'programme_note_en as programmeNoteEn',
    ])
    .orderBy('name');
  if (vesselId) query = query.where('id', '=', vesselId);
  return query.execute();
}

async function loadGuestInfo(tx: Tx): Promise<GuestInfoTexts> {
  const row = await tx.selectFrom('guest_info_setting').selectAll().executeTakeFirst();
  return {
    whatToBringAr: row?.what_to_bring_ar ?? null,
    whatToBringEn: row?.what_to_bring_en ?? null,
    dressCodeAr: row?.dress_code_ar ?? null,
    dressCodeEn: row?.dress_code_en ?? null,
    documentsAr: row?.documents_ar ?? null,
    documentsEn: row?.documents_en ?? null,
  };
}

/** For the On board settings card: every vessel's day, every port's guide, the texts. */
export async function getOperationsSettings(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => ({
    vessels: await loadVessels(tx),
    ports: (await tx
      .selectFrom('port')
      .select([
        'id',
        'code',
        'name_ar as nameAr',
        'name_en as nameEn',
        'berth_ar as berthAr',
        'berth_en as berthEn',
        'visits_ar as visitsAr',
        'visits_en as visitsEn',
      ])
      .where('active', '=', true)
      .orderBy('code')
      .execute()) satisfies PortGuide[],
    guestInfo: await loadGuestInfo(tx),
  }));
}

export const updateVesselDayInput = z.object({
  vesselId: z.uuid(),
  boardingTime: time.optional(),
  breakfastTime: time.optional(),
  lunchTime: time.optional(),
  teaTime: time.optional(),
  dinnerTime: time.optional(),
  luggageTime: time.optional(),
  checkoutTime: time.optional(),
  programmeNoteAr: text(1000).optional(),
  programmeNoteEn: text(1000).optional(),
});

export async function updateVesselDay(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateVesselDayInput>,
) {
  const { vesselId, ...data } = parseInput(updateVesselDayInput, input);
  const set: Record<string, string | null> = {};
  for (const [key, column] of Object.entries(VESSEL_TIMES)) {
    const value = data[key as keyof typeof VESSEL_TIMES];
    if (value !== undefined) set[column] = value;
  }
  if (data.programmeNoteAr !== undefined) set.programme_note_ar = data.programmeNoteAr;
  if (data.programmeNoteEn !== undefined) set.programme_note_en = data.programmeNoteEn;
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = (await loadVessels(tx, vesselId))[0];
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
    if (Object.keys(set).length)
      await tx.updateTable('vessel').set(set).where('id', '=', vesselId).execute();
    const after = (await loadVessels(tx, vesselId))[0]!;
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'vessel.day_updated',
      entity: 'vessel',
      entityId: vesselId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  });
}

export const updatePortGuideInput = z.object({
  portId: z.uuid(),
  berthAr: text(300).optional(),
  berthEn: text(300).optional(),
  visitsAr: text(600).optional(),
  visitsEn: text(600).optional(),
});

export async function updatePortGuide(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updatePortGuideInput>,
) {
  const { portId, ...data } = parseInput(updatePortGuideInput, input);
  const columns = {
    berthAr: 'berth_ar',
    berthEn: 'berth_en',
    visitsAr: 'visits_ar',
    visitsEn: 'visits_en',
  } as const;
  const set = Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [columns[k as keyof typeof columns], v]),
  );
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('port')
      .select(['id', 'berth_ar', 'berth_en', 'visits_ar', 'visits_en'])
      .where('id', '=', portId)
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Port not found' });
    if (Object.keys(set).length)
      await tx.updateTable('port').set(set).where('id', '=', portId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'port.guide_updated',
      entity: 'port',
      entityId: portId,
      before,
      after: { ...before, ...set },
    });
    return { portId };
  });
}

export const updateGuestInfoInput = z.object({
  whatToBringAr: text(1500).optional(),
  whatToBringEn: text(1500).optional(),
  dressCodeAr: text(800).optional(),
  dressCodeEn: text(800).optional(),
  documentsAr: text(800).optional(),
  documentsEn: text(800).optional(),
});

export async function updateGuestInfo(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateGuestInfoInput>,
) {
  const data = parseInput(updateGuestInfoInput, input);
  const columns = {
    whatToBringAr: 'what_to_bring_ar',
    whatToBringEn: 'what_to_bring_en',
    dressCodeAr: 'dress_code_ar',
    dressCodeEn: 'dress_code_en',
    documentsAr: 'documents_ar',
    documentsEn: 'documents_en',
  } as const;
  const set = Object.fromEntries(
    Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [columns[k as keyof typeof columns], v]),
  );
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await loadGuestInfo(tx);
    await tx
      .insertInto('guest_info_setting')
      .values({ operator_id: ctx.operatorId, ...set })
      .onConflict((oc) =>
        oc
          .column('operator_id')
          .doUpdateSet(Object.keys(set).length ? set : { operator_id: ctx.operatorId }),
      )
      .execute();
    const after = await loadGuestInfo(tx);
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'guest_info.updated',
      entity: 'operator',
      entityId: ctx.operatorId,
      before: { ...before },
      after: { ...after },
    });
    return after;
  });
}

// ---------------------------------------------------------------------------
// The daily programme
// ---------------------------------------------------------------------------

export interface ProgrammeDay {
  date: string;
  /** Arrivals and departures that day, from the schedule's stop times, in time order. */
  stops: {
    time: string | null;
    kind: 'arrive' | 'depart';
    port: { code: string; nameAr: string; nameEn: string };
  }[];
  /** What guests visit at the ports of the day (from the port guide). */
  visits: { port: { nameAr: string; nameEn: string }; ar: string | null; en: string | null }[];
}

export interface DailyProgrammeData {
  vessel: VesselDay;
  days: ProgrammeDay[];
}

export interface DailyProgrammeParams {
  from: string;
  days: number;
}

/**
 * One page per day for a vessel: where it arrives and leaves and when (the schedule's stop
 * times), what guests visit there, and the vessel's meal times and note.
 */
export async function dailyProgrammeData(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
  params: DailyProgrammeParams,
): Promise<DailyProgrammeData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessel = (await loadVessels(tx, vesselId))[0];
    if (!vessel) throw new DomainError('NOT_FOUND', { message: 'Vessel not found' });
    const from = params.from as BusinessDate;
    const to = addDays(from, params.days - 1);
    // Every stop of the schedule cycles running in the range, dated by its cycle.
    const { rows } = await sql<{
      date: string;
      seq: number;
      arrive: string | null;
      depart: string | null;
      code: string;
      name_ar: string;
      name_en: string;
      visits_ar: string | null;
      visits_en: string | null;
    }>`
      select distinct (c.cycle_start + st.day_offset)::text as date, st.seq,
             to_char(st.arrive_time, 'HH24:MI') as arrive, to_char(st.depart_time, 'HH24:MI') as depart,
             p.code, p.name_ar, p.name_en, p.visits_ar, p.visits_en
      from (select distinct template_id, cycle_start from vs.leg
            where vessel_id = ${vesselId} and template_id is not null and status <> 'cancelled'
              and cycle_start between ${from}::date - 60 and ${to}::date) c
      join vs.schedule_template_stop st on st.template_id = c.template_id
      join vs.port p on p.id = st.port_id
      where (c.cycle_start + st.day_offset) between ${from}::date and ${to}::date
      order by 1, 2`.execute(tx);
    const days: ProgrammeDay[] = [];
    for (let i = 0; i < params.days; i++) {
      const date = addDays(from, i);
      const today = rows.filter((r) => r.date === date);
      const stops: ProgrammeDay['stops'] = [];
      const visits: ProgrammeDay['visits'] = [];
      for (const r of today) {
        const port = { code: r.code, nameAr: r.name_ar, nameEn: r.name_en };
        // The day one cycle ends is the day the next begins: the same stop can come twice.
        const add = (time: string | null, kind: 'arrive' | 'depart') => {
          if (!stops.some((s) => s.time === time && s.kind === kind && s.port.code === r.code))
            stops.push({ time, kind, port });
        };
        if (r.arrive) add(r.arrive, 'arrive');
        if (r.depart) add(r.depart, 'depart');
        if (!r.arrive && !r.depart) add(null, 'arrive');
        if ((r.visits_ar || r.visits_en) && !visits.some((v) => v.port.nameEn === r.name_en))
          visits.push({
            port: { nameAr: r.name_ar, nameEn: r.name_en },
            ar: r.visits_ar,
            en: r.visits_en,
          });
      }
      stops.sort((a, b) => (a.time ?? '99').localeCompare(b.time ?? '99'));
      days.push({ date, stops, visits });
    }
    return { vessel, days };
  });
}

// ---------------------------------------------------------------------------
// The guest's pre-departure information
// ---------------------------------------------------------------------------

export interface PredepartureData {
  ref: string;
  vessel: string;
  cruise: { nameAr: string; nameEn: string; nights: number };
  embark: {
    date: string;
    port: { nameAr: string; nameEn: string };
    berthAr: string | null;
    berthEn: string | null;
    boardingTime: string | null;
    departTime: string | null;
  };
  disembark: {
    date: string;
    port: { nameAr: string; nameEn: string };
    arriveTime: string | null;
    checkoutTime: string | null;
  };
  guests: { name: string; lead: boolean }[];
  /** A passport should stay valid six months after the cruise ends. */
  passportValidUntil: string;
  texts: GuestInfoTexts;
}

/** What a guest needs before the cruise: where and when to board, what to bring, contacts. */
export async function predepartureData(
  db: VsDatabase,
  ctx: EngineContext,
  bookingId: string,
): Promise<PredepartureData> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<{
      ref: string;
      vessel_id: string;
      vessel: string;
      name_ar: string;
      name_en: string;
      nights: number;
      embark_date: string;
      embark_ar: string;
      embark_en: string;
      berth_ar: string | null;
      berth_en: string | null;
      depart_time: string | null;
      disembark_date: string;
      disembark_ar: string;
      disembark_en: string;
      arrive_time: string | null;
      valid_until: string;
    }>`
      select b.ref, b.vessel_id, v.name as vessel, sp.name_ar, sp.name_en, s.nights,
             s.embark_date::text, ep.name_ar as embark_ar, ep.name_en as embark_en,
             ep.berth_ar, ep.berth_en, to_char(es.depart_time, 'HH24:MI') as depart_time,
             s.disembark_date::text, dp.name_ar as disembark_ar, dp.name_en as disembark_en,
             to_char(ds.arrive_time, 'HH24:MI') as arrive_time,
             (s.disembark_date + interval '6 months')::date::text as valid_until
      from vs.booking b
      join vs.vessel v on v.id = b.vessel_id
      join vs.sailing s on s.id = b.sailing_id
      left join vs.sailing_pattern sp on sp.id = s.pattern_id
      join vs.port ep on ep.id = s.embark_port_id
      join vs.port dp on dp.id = s.disembark_port_id
      left join vs.schedule_template_stop es on es.template_id = sp.template_id and es.seq = sp.embark_stop_seq
      left join vs.schedule_template_stop ds on ds.template_id = sp.template_id and ds.seq = sp.disembark_stop_seq
      where b.id = ${bookingId}`.execute(tx);
    const r = rows[0];
    if (!r) throw new DomainError('NOT_FOUND', { message: 'Booking not found' });
    const vessel = (await loadVessels(tx, r.vessel_id))[0]!;
    const guests = await tx
      .selectFrom('guest')
      .select(['first_name', 'last_name', 'title', 'lead'])
      .where('booking_id', '=', bookingId)
      .orderBy('lead', 'desc')
      .orderBy('created_at')
      .execute();
    return {
      ref: r.ref,
      vessel: r.vessel,
      cruise: { nameAr: r.name_ar ?? '', nameEn: r.name_en ?? '', nights: r.nights },
      embark: {
        date: r.embark_date,
        port: { nameAr: r.embark_ar, nameEn: r.embark_en },
        berthAr: r.berth_ar,
        berthEn: r.berth_en,
        boardingTime: vessel.boardingTime,
        departTime: r.depart_time,
      },
      disembark: {
        date: r.disembark_date,
        port: { nameAr: r.disembark_ar, nameEn: r.disembark_en },
        arriveTime: r.arrive_time,
        checkoutTime: vessel.checkoutTime,
      },
      guests: guests.map((g) => ({
        name: [g.title, g.first_name, g.last_name].filter(Boolean).join(' '),
        lead: g.lead,
      })),
      passportValidUntil: r.valid_until,
      texts: await loadGuestInfo(tx),
    };
  });
}

export const dailyProgrammeInput = z.object({
  vesselId: z.uuid(),
  from: dateSchema,
  days: z.number().int().min(1).max(14).default(7),
});
