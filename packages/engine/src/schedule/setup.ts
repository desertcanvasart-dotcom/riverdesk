import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { businessDate } from '@vs/shared';
import { audit } from '../audit';
import { lockVessel, parseInput, type EngineContext } from '../internal';

const code = z.string().regex(/^[A-Z][A-Z0-9_]{0,15}$/);
const dateString = z.string().transform((value, ctx) => {
  try {
    return businessDate(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Expected a date YYYY-MM-DD' });
    return z.NEVER;
  }
});
export const dateSchema = dateString;

export const createPortInput = z.object({
  code: code.min(2),
  nameEn: z.string().min(1).max(100),
  nameAr: z.string().min(1).max(100),
});

export async function createPort(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createPortInput>,
) {
  const data = parseInput(createPortInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const port = await tx
      .insertInto('port')
      .values({
        operator_id: ctx.operatorId,
        code: data.code,
        name_en: data.nameEn,
        name_ar: data.nameAr,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'port.created',
      entity: 'port',
      entityId: port.id,
      after: port,
    });
    return port;
  });
}

export const createVesselInput = z.object({
  code: code.min(2),
  name: z.string().min(1).max(200),
  type: z.enum(['cruise_ship', 'dahabiya', 'steam']),
  maxGuests: z.number().int().positive(),
  sellsCabins: z.boolean().default(true),
  sellsCharter: z.boolean().default(false),
});

export async function createVessel(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createVesselInput>,
) {
  const data = parseInput(createVesselInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const vessel = await tx
      .insertInto('vessel')
      .values({
        operator_id: ctx.operatorId,
        code: data.code,
        name: data.name,
        type: data.type,
        max_guests: data.maxGuests,
        sells_cabins: data.sellsCabins,
        sells_charter: data.sellsCharter,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'vessel.created',
      entity: 'vessel',
      entityId: vessel.id,
      after: vessel,
    });
    return vessel;
  });
}

export const createCabinCategoryInput = z
  .object({
    vesselId: z.uuid(),
    code,
    nameEn: z.string().min(1).max(100),
    nameAr: z.string().min(1).max(100),
    deck: z.string().max(50).optional(),
    view: z.string().max(50).optional(),
    bedConfig: z.string().max(50).optional(),
    maxAdults: z.number().int().min(1).max(10),
    maxOccupancy: z.number().int().min(1).max(12),
    extraBedAllowed: z.boolean().default(false),
    sortOrder: z.number().int().default(0),
  })
  .refine(
    (value) => value.maxOccupancy >= value.maxAdults,
    'maxOccupancy must be at least maxAdults',
  );

/**
 * A new category has no cabins, so it changes no counts. Cabins enter it through
 * changeCapacity, which also creates its pool buckets on legs that already exist.
 */
export async function createCabinCategory(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createCabinCategoryInput>,
) {
  const data = parseInput(createCabinCategoryInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockVessel(tx, data.vesselId);
    const category = await tx
      .insertInto('cabin_category')
      .values({
        operator_id: ctx.operatorId,
        vessel_id: data.vesselId,
        code: data.code,
        name_en: data.nameEn,
        name_ar: data.nameAr,
        deck: data.deck ?? null,
        view: data.view ?? null,
        bed_config: data.bedConfig ?? null,
        max_adults: data.maxAdults,
        max_occupancy: data.maxOccupancy,
        extra_bed_allowed: data.extraBedAllowed,
        sort_order: data.sortOrder,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'cabin_category.created',
      entity: 'cabin_category',
      entityId: category.id,
      after: category,
    });
    return category;
  });
}

const stopSchema = z.object({
  portId: z.uuid(),
  dayOffset: z.number().int().min(0),
  arriveTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  departTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  embarkAllowed: z.boolean().default(false),
  disembarkAllowed: z.boolean().default(false),
});

export const createScheduleTemplateInput = z.object({
  vesselId: z.uuid(),
  name: z.string().min(1).max(200),
  cycleDays: z.number().int().min(1).max(60),
  validFrom: dateString,
  validTo: dateString.optional(),
  stops: z.array(stopSchema).min(2).max(60),
});

export type TemplateStop = z.infer<typeof stopSchema>;

/**
 * Rules for a cycle of stops: the first stop is day 0, offsets never go back, the last stop is
 * day `cycleDays` at the same port as the first (where the next cycle starts), and guests can
 * board and leave at both ends. Returns problem codes (the back office translates them).
 */
export function validateTemplateStops(stops: TemplateStop[], cycleDays: number): string[] {
  const problems: string[] = [];
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  if (first.dayOffset !== 0) problems.push('first_stop_day0');
  if (last.dayOffset !== cycleDays) problems.push('last_stop_day_cycle');
  if (last.portId !== first.portId) problems.push('cycle_returns');
  for (const end of [first, last]) {
    if (!end.embarkAllowed || !end.disembarkAllowed) {
      problems.push('ends_boarding');
      break;
    }
  }
  stops.forEach((stop, index) => {
    if (index > 0 && stop.dayOffset < stops[index - 1]!.dayOffset) {
      problems.push('stop_order');
    }
  });
  const boarding = stops.filter((stop) => stop.embarkAllowed || stop.disembarkAllowed);
  boarding.forEach((stop, index) => {
    if (index > 0 && stop.dayOffset === boarding[index - 1]!.dayOffset) {
      problems.push('zero_night_leg');
    }
  });
  return [...new Set(problems)];
}

export async function createScheduleTemplate(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createScheduleTemplateInput>,
) {
  const data = parseInput(createScheduleTemplateInput, input);
  const problems = validateTemplateStops(data.stops, data.cycleDays);
  if (data.validTo && data.validTo < data.validFrom) problems.push('ends_before_start');
  if (problems.length > 0) throw new DomainError('VALIDATION_FAILED', { details: { problems } });

  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await lockVessel(tx, data.vesselId);
    const template = await tx
      .insertInto('schedule_template')
      .values({
        operator_id: ctx.operatorId,
        vessel_id: data.vesselId,
        name: data.name,
        cycle_days: data.cycleDays,
        valid_from: data.validFrom,
        valid_to: data.validTo ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('schedule_template_stop')
      .values(
        data.stops.map((stop, seq) => ({
          operator_id: ctx.operatorId,
          template_id: template.id,
          seq,
          port_id: stop.portId,
          day_offset: stop.dayOffset,
          arrive_time: stop.arriveTime ?? null,
          depart_time: stop.departTime ?? null,
          embark_allowed: stop.embarkAllowed,
          disembark_allowed: stop.disembarkAllowed,
        })),
      )
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'schedule_template.created',
      entity: 'schedule_template',
      entityId: template.id,
      after: { ...template, stops: data.stops },
    });
    return template;
  });
}

export const createSailingPatternInput = z.object({
  templateId: z.uuid(),
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,23}$/),
  nameEn: z.string().min(1).max(100),
  nameAr: z.string().min(1).max(100),
  embarkStopSeq: z.number().int().min(0),
  disembarkStopSeq: z.number().int().min(1),
  /** 0 = disembark in the same cycle; 1 = in the next cycle (e.g. 7 nights from Aswan). */
  disembarkCycleOffset: z.number().int().min(0).max(8).default(0),
});

/** A sellable cruise: from a boarding stop to a later one, possibly in a later cycle. */
export async function createSailingPattern(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSailingPatternInput>,
) {
  const data = parseInput(createSailingPatternInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const template = await tx
      .selectFrom('schedule_template')
      .selectAll()
      .where('id', '=', data.templateId)
      .executeTakeFirst();
    if (!template) throw new DomainError('NOT_FOUND', { message: 'Template not found' });
    await lockVessel(tx, template.vessel_id);
    const stops = await tx
      .selectFrom('schedule_template_stop')
      .selectAll()
      .where('template_id', '=', template.id)
      .orderBy('seq')
      .execute();
    const lastSeq = stops.length - 1;
    const embark = stops[data.embarkStopSeq];
    const disembark = stops[data.disembarkStopSeq];
    const problems: string[] = [];
    if (!embark || data.embarkStopSeq >= lastSeq) problems.push('embark_before_last');
    else if (!embark.embark_allowed) problems.push('embark_not_boarding');
    if (!disembark) problems.push('disembark_missing');
    else if (!disembark.disembark_allowed) problems.push('disembark_not_leaving');
    if (data.disembarkCycleOffset === 0 && data.disembarkStopSeq <= data.embarkStopSeq) {
      problems.push('disembark_after_embark');
    }
    if (problems.length > 0 || !embark || !disembark) {
      throw new DomainError('VALIDATION_FAILED', { details: { problems } });
    }
    const nights =
      data.disembarkCycleOffset * template.cycle_days + disembark.day_offset - embark.day_offset;
    const pattern = await tx
      .insertInto('sailing_pattern')
      .values({
        operator_id: ctx.operatorId,
        vessel_id: template.vessel_id,
        template_id: template.id,
        code: data.code,
        name_en: data.nameEn,
        name_ar: data.nameAr,
        embark_stop_seq: data.embarkStopSeq,
        disembark_stop_seq: data.disembarkStopSeq,
        disembark_cycle_offset: data.disembarkCycleOffset,
        nights,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'sailing_pattern.created',
      entity: 'sailing_pattern',
      entityId: pattern.id,
      after: pattern,
    });
    return pattern;
  });
}
