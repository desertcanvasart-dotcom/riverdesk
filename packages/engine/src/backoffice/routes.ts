import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { pgErrorCode } from '@vs/shared';
import { audit } from '../audit';
import { lockVessel, parseInput, type EngineContext, type Tx } from '../internal';
import { DEMO_PORTS } from '../demo';
import {
  createPort,
  createPortInput,
  createSailingPattern,
  createSailingPatternInput,
  createScheduleTemplate,
  createScheduleTemplateInput,
  dateSchema,
  validateTemplateStops,
} from '../schedule/setup';

/**
 * Ports, routes and itineraries (Batch 8, step 2). A route (schedule template) is the repeating
 * cycle of stops; departures (legs) are generated between its boarding stops, and itineraries
 * (sailing patterns) are the cruises sold over them. Once a route has departures or itineraries,
 * its stops are fixed: what was sold never changes underneath. It can still be renamed or ended.
 */

export interface RoutePort {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  active: boolean;
  /** Stops on routes that are still running. */
  usedBy: number;
}

export interface RouteStop {
  seq: number;
  portId: string;
  dayOffset: number;
  arriveTime: string | null;
  departTime: string | null;
  embarkAllowed: boolean;
  disembarkAllowed: boolean;
}

export interface RouteItinerary {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  embarkStopSeq: number;
  disembarkStopSeq: number;
  disembarkCycleOffset: number;
  nights: number;
  active: boolean;
  sailings: number;
}

export interface Route {
  id: string;
  name: string;
  cycleDays: number;
  validFrom: string;
  validTo: string | null;
  stops: RouteStop[];
  itineraries: RouteItinerary[];
  /** All departures ever generated from this route, and those from today on. */
  legs: number;
  upcomingLegs: number;
  lastDeparture: string | null;
}

const runningRoute = sql<boolean>`(t.active and (t.valid_to is null or t.valid_to >= (now() at time zone 'Africa/Cairo')::date))`;

export async function getRoutes(
  db: VsDatabase,
  ctx: EngineContext,
  vesselId: string,
): Promise<{ ports: RoutePort[]; routes: Route[] }> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows: ports } = await sql<RoutePort>`
      select p.id, p.code, p.name_en as "nameEn", p.name_ar as "nameAr", p.active,
             (select count(*)::int from vs.schedule_template_stop s
              join vs.schedule_template t on t.id = s.template_id
              where s.port_id = p.id and ${runningRoute}) as "usedBy"
      from vs.port p order by p.active desc, p.code`.execute(tx);
    const { rows: templates } = await sql<{
      id: string;
      name: string;
      cycleDays: number;
      validFrom: string;
      validTo: string | null;
      legs: number;
      upcomingLegs: number;
      lastDeparture: string | null;
    }>`
      select t.id, t.name, t.cycle_days as "cycleDays", t.valid_from::text as "validFrom",
             t.valid_to::text as "validTo",
             (select count(*)::int from vs.leg l where l.template_id = t.id) as legs,
             (select count(*)::int from vs.leg l where l.template_id = t.id
                and l.depart_date >= (now() at time zone 'Africa/Cairo')::date) as "upcomingLegs",
             (select max(l.depart_date)::text from vs.leg l where l.template_id = t.id) as "lastDeparture"
      from vs.schedule_template t
      where t.vessel_id = ${vesselId} and t.active
      order by t.valid_from, t.name`.execute(tx);
    const ids = templates.map((t) => t.id);
    const stops = ids.length
      ? await tx
          .selectFrom('schedule_template_stop')
          .selectAll()
          .where('template_id', 'in', ids)
          .orderBy('seq')
          .execute()
      : [];
    const { rows: patterns } = ids.length
      ? await sql<RouteItinerary & { templateId: string }>`
          select sp.id, sp.template_id as "templateId", sp.code, sp.name_en as "nameEn",
                 sp.name_ar as "nameAr", sp.embark_stop_seq as "embarkStopSeq",
                 sp.disembark_stop_seq as "disembarkStopSeq",
                 sp.disembark_cycle_offset as "disembarkCycleOffset", sp.nights, sp.active,
                 (select count(*)::int from vs.sailing s where s.pattern_id = sp.id) as sailings
          from vs.sailing_pattern sp where sp.template_id = any(${ids}::uuid[])
          order by sp.code`.execute(tx)
      : { rows: [] };
    return {
      ports,
      routes: templates.map((t) => ({
        ...t,
        stops: stops
          .filter((s) => s.template_id === t.id)
          .map((s) => ({
            seq: s.seq,
            portId: s.port_id,
            dayOffset: s.day_offset,
            arriveTime: s.arrive_time?.slice(0, 5) ?? null,
            departTime: s.depart_time?.slice(0, 5) ?? null,
            embarkAllowed: s.embark_allowed,
            disembarkAllowed: s.disembark_allowed,
          })),
        itineraries: patterns
          .filter((p) => p.templateId === t.id)
          .map(({ templateId: _, ...p }) => p),
      })),
    };
  });
}

/** A unique code already used: a clear refusal instead of a database error. */
async function unique<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (pgErrorCode(error) === '23505')
      throw new DomainError('VALIDATION_FAILED', {
        message: 'Already used',
        details: { reason: 'code_taken' },
      });
    throw error;
  }
}

/** Rule problems as stable codes the screen can translate. */
function invalid(problems: string[]): never {
  throw new DomainError('VALIDATION_FAILED', {
    message: problems.join('; '),
    details: { reason: 'invalid_route', problems },
  });
}

export async function addPort(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createPortInput>,
) {
  return unique(() => createPort(db, ctx, input));
}

/** The usual Nile ports, skipping codes the company already has. */
export async function addUsualPorts(db: VsDatabase, ctx: EngineContext): Promise<number> {
  const existing = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx.selectFrom('port').select('code').execute(),
  );
  const have = new Set(existing.map((p) => p.code));
  let added = 0;
  for (const port of DEMO_PORTS) {
    if (have.has(port.code)) continue;
    await createPort(db, ctx, port);
    added += 1;
  }
  return added;
}

export const updatePortInput = z.object({
  portId: z.uuid(),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  active: z.boolean(),
});

/** Names and whether the port is offered for new routes; a port on a running route stays. */
export async function updatePort(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updatePortInput>,
) {
  const data = parseInput(updatePortInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('port')
      .selectAll()
      .where('id', '=', data.portId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Port not found' });
    if (!data.active && before.active) {
      const { rows } = await sql<{ n: number }>`
        select count(*)::int as n from vs.schedule_template_stop s
        join vs.schedule_template t on t.id = s.template_id
        where s.port_id = ${data.portId} and ${runningRoute}`.execute(tx);
      if (rows[0]!.n > 0)
        throw new DomainError('INVALID_STATE', {
          message: 'The port is on a running route',
          details: { reason: 'port_in_use' },
        });
    }
    const after = await tx
      .updateTable('port')
      .set({ name_en: data.nameEn, name_ar: data.nameAr, active: data.active })
      .where('id', '=', data.portId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'port.updated',
      entity: 'port',
      entityId: data.portId,
      before: { name_en: before.name_en, name_ar: before.name_ar, active: before.active },
      after: { name_en: after.name_en, name_ar: after.name_ar, active: after.active },
    });
    return after;
  });
}

/** Ports must be the company's own and offered for new routes. */
async function checkPorts(tx: Tx, portIds: string[]) {
  const ports = await tx
    .selectFrom('port')
    .select(['id', 'active'])
    .where('id', 'in', [...new Set(portIds)])
    .execute();
  if (ports.length !== new Set(portIds).size || ports.some((p) => !p.active))
    invalid(['inactive_port']);
}

export async function addRoute(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createScheduleTemplateInput>,
) {
  const data = parseInput(createScheduleTemplateInput, input);
  const problems = validateTemplateStops(data.stops, data.cycleDays);
  if (problems.length > 0) invalid(problems);
  await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    checkPorts(
      tx,
      data.stops.map((s) => s.portId),
    ),
  );
  return createScheduleTemplate(db, ctx, input);
}

export const updateRouteInput = z.object({
  routeId: z.uuid(),
  name: z.string().trim().min(1).max(200),
  /** The last date a cycle may start; null keeps the route running. */
  validTo: dateSchema.nullable(),
});

/**
 * Name and end date, at any time. Ending a route stops new departures after that date; the
 * departures already generated stay (cancel them on Schedule if they must not sail).
 */
export async function updateRoute(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateRouteInput>,
) {
  const data = parseInput(updateRouteInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await lockRoute(tx, data.routeId);
    if (data.validTo && data.validTo < before.valid_from) invalid(['ends_before_start']);
    const after = await tx
      .updateTable('schedule_template')
      .set({ name: data.name, valid_to: data.validTo })
      .where('id', '=', data.routeId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'schedule_template.updated',
      entity: 'schedule_template',
      entityId: data.routeId,
      before: { name: before.name, valid_to: before.valid_to },
      after: { name: after.name, valid_to: after.valid_to },
    });
    return after;
  });
}

export const replaceRouteStopsInput = createScheduleTemplateInput
  .omit({ vesselId: true, name: true, validTo: true })
  .extend({ routeId: z.uuid() });

/** Stops, cycle and first date: only while the route has no departures and no itineraries. */
export async function replaceRouteStops(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof replaceRouteStopsInput>,
) {
  const data = parseInput(replaceRouteStopsInput, input);
  const problems = validateTemplateStops(data.stops, data.cycleDays);
  if (problems.length > 0) invalid(problems);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await lockRoute(tx, data.routeId);
    await assertUnused(tx, data.routeId);
    await checkPorts(
      tx,
      data.stops.map((s) => s.portId),
    );
    if (before.valid_to && before.valid_to < data.validFrom) invalid(['ends_before_start']);
    const oldStops = await tx
      .selectFrom('schedule_template_stop')
      .selectAll()
      .where('template_id', '=', data.routeId)
      .orderBy('seq')
      .execute();
    await tx.deleteFrom('schedule_template_stop').where('template_id', '=', data.routeId).execute();
    await tx
      .insertInto('schedule_template_stop')
      .values(
        data.stops.map((stop, seq) => ({
          operator_id: ctx.operatorId,
          template_id: data.routeId,
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
    const after = await tx
      .updateTable('schedule_template')
      .set({ cycle_days: data.cycleDays, valid_from: data.validFrom })
      .where('id', '=', data.routeId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'schedule_template.stops_replaced',
      entity: 'schedule_template',
      entityId: data.routeId,
      before: {
        cycle_days: before.cycle_days,
        valid_from: before.valid_from,
        stops: oldStops.map((s) => ({ port_id: s.port_id, day_offset: s.day_offset })),
      },
      after: {
        cycle_days: after.cycle_days,
        valid_from: after.valid_from,
        stops: data.stops.map((s) => ({ port_id: s.portId, day_offset: s.dayOffset })),
      },
    });
    return after;
  });
}

/** A route set up by mistake: only while it has no departures and no itineraries. */
export async function deleteRoute(db: VsDatabase, ctx: EngineContext, routeId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await lockRoute(tx, routeId);
    await assertUnused(tx, routeId);
    await tx.deleteFrom('schedule_template_stop').where('template_id', '=', routeId).execute();
    await tx.deleteFrom('schedule_template').where('id', '=', routeId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'schedule_template.deleted',
      entity: 'schedule_template',
      entityId: routeId,
      before: { name: before.name, vessel_id: before.vessel_id },
    });
  });
}

async function lockRoute(tx: Tx, routeId: string) {
  const route = await tx
    .selectFrom('schedule_template')
    .selectAll()
    .where('id', '=', routeId)
    .executeTakeFirst();
  if (!route) throw new DomainError('NOT_FOUND', { message: 'Route not found' });
  await lockVessel(tx, route.vessel_id);
  return route;
}

async function assertUnused(tx: Tx, routeId: string) {
  const { rows } = await sql<{ legs: number; patterns: number }>`
    select (select count(*)::int from vs.leg where template_id = ${routeId}) as legs,
           (select count(*)::int from vs.sailing_pattern where template_id = ${routeId}) as patterns`.execute(
    tx,
  );
  if (rows[0]!.legs > 0 || rows[0]!.patterns > 0)
    throw new DomainError('INVALID_STATE', {
      message: 'The route already has departures or itineraries',
      details: { reason: 'route_in_use' },
    });
}

export async function addItinerary(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof createSailingPatternInput>,
) {
  return unique(async () => {
    try {
      return await createSailingPattern(db, ctx, input);
    } catch (error) {
      const problems = (error as { details?: { problems?: string[] } }).details?.problems;
      if (problems?.length) invalid(problems);
      throw error;
    }
  });
}

export const updateItineraryInput = z.object({
  itineraryId: z.uuid(),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  /** Paused itineraries get no new sailings; the ones already generated stay on sale. */
  active: z.boolean(),
});

export async function updateItinerary(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateItineraryInput>,
) {
  const data = parseInput(updateItineraryInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('sailing_pattern')
      .selectAll()
      .where('id', '=', data.itineraryId)
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Itinerary not found' });
    await lockVessel(tx, before.vessel_id);
    const after = await tx
      .updateTable('sailing_pattern')
      .set({ name_en: data.nameEn, name_ar: data.nameAr, active: data.active })
      .where('id', '=', data.itineraryId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'sailing_pattern.updated',
      entity: 'sailing_pattern',
      entityId: data.itineraryId,
      before: { name_en: before.name_en, name_ar: before.name_ar, active: before.active },
      after: { name_en: after.name_en, name_ar: after.name_ar, active: after.active },
    });
    return after;
  });
}

/** An itinerary set up by mistake: only while it has no sailings and no package rates. */
export async function deleteItinerary(db: VsDatabase, ctx: EngineContext, itineraryId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('sailing_pattern')
      .selectAll()
      .where('id', '=', itineraryId)
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Itinerary not found' });
    await lockVessel(tx, before.vessel_id);
    const { rows } = await sql<{ n: number }>`
      select (select count(*)::int from vs.sailing where pattern_id = ${itineraryId})
           + (select count(*)::int from vs.rate where sailing_pattern_id = ${itineraryId}) as n`.execute(
      tx,
    );
    if (rows[0]!.n > 0)
      throw new DomainError('INVALID_STATE', {
        message: 'The itinerary already has sailings or rates',
        details: { reason: 'itinerary_in_use' },
      });
    await tx.deleteFrom('sailing_pattern').where('id', '=', itineraryId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'sailing_pattern.deleted',
      entity: 'sailing_pattern',
      entityId: itineraryId,
      before: { code: before.code, name_en: before.name_en },
    });
  });
}
