import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, operatorsCreatedHere, owner, testConfig } from '@vs/db/testing';
import { addDays, systemActor } from '@vs/shared';
import {
  addCabinCategory,
  addCabins,
  addItinerary,
  addPort,
  addRoute,
  addUsualPorts,
  addVessel,
  deleteItinerary,
  deleteRoute,
  generateSchedule,
  getRoutes,
  openDatabase,
  replaceRouteStops,
  updateItinerary,
  updatePort,
  updateRoute,
  type EngineContext,
  type VsDatabase,
} from '../src/index';

describe('Ports, routes and itineraries (setup screens)', () => {
  let db: VsDatabase;
  let ctx: EngineContext;
  let vesselId: string;
  let port: Record<string, string>;
  let monday: string;

  beforeAll(async () => {
    db = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
    const operatorId = await createOperator('Routes test operator');
    operatorsCreatedHere().add(operatorId);
    ctx = { operatorId, actor: systemActor('test') };
    const ship = await addVessel(db, ctx, {
      code: 'ROUTES',
      name: 'Routes Ship',
      type: 'cruise_ship',
      maxGuests: 40,
    });
    vesselId = ship.id;
    const category = await addCabinCategory(db, ctx, {
      vesselId,
      code: 'STD',
      nameEn: 'Standard',
      nameAr: 'ستاندرد',
      maxAdults: 2,
      maxOccupancy: 3,
    });
    const { rows } = await owner().query<{ d: string }>(
      `select (now() at time zone 'Africa/Cairo')::date::text as d`,
    );
    const today = rows[0]!.d;
    await addCabins(db, ctx, {
      vesselId,
      categoryId: category.id,
      numbers: ['1', '2', '3'],
      effectiveFrom: today,
      reason: 'setup',
    });
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    monday = addDays(today as never, ((8 - weekday) % 7) + 7);
  });

  afterAll(async () => {
    await db.close();
  });

  const weekly = () => [
    { portId: port.LXR!, dayOffset: 0, embarkAllowed: true, disembarkAllowed: true },
    { portId: port.EDF!, dayOffset: 2 },
    { portId: port.ASW!, dayOffset: 4, embarkAllowed: true, disembarkAllowed: true },
    { portId: port.LXR!, dayOffset: 7, embarkAllowed: true, disembarkAllowed: true },
  ];

  it('adds the usual Nile ports once, and refuses a port code already used', async () => {
    expect(await addUsualPorts(db, ctx)).toBe(9);
    expect(await addUsualPorts(db, ctx)).toBe(0);
    await expect(
      addPort(db, ctx, { code: 'LXR', nameEn: 'Luxor', nameAr: 'الأقصر' }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });
    const { ports } = await getRoutes(db, ctx, vesselId);
    port = Object.fromEntries(ports.map((p) => [p.code, p.id]));
    expect(Object.keys(port)).toContain('ASW');
  });

  it('refuses a route that breaks the rules, with codes the screen can translate', async () => {
    await expect(
      addRoute(db, ctx, {
        vesselId,
        name: 'Broken',
        cycleDays: 7,
        validFrom: monday,
        stops: [
          { portId: port.LXR!, dayOffset: 0, embarkAllowed: true, disembarkAllowed: true },
          { portId: port.ASW!, dayOffset: 7, embarkAllowed: true, disembarkAllowed: true },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { reason: 'invalid_route', problems: ['cycle_returns'] },
    });
  });

  it('a route and its itineraries; stops stay editable until itineraries or departures exist', async () => {
    const route = await addRoute(db, ctx, {
      vesselId,
      name: 'Luxor ⇄ Aswan',
      cycleDays: 7,
      validFrom: monday,
      stops: weekly(),
    });
    const itinerary = await addItinerary(db, ctx, {
      templateId: route.id,
      code: 'LXR-4',
      nameEn: '4 nights from Luxor',
      nameAr: '٤ ليالٍ من الأقصر',
      embarkStopSeq: 0,
      disembarkStopSeq: 2,
    });
    expect(itinerary.nights).toBe(4);
    await expect(
      addItinerary(db, ctx, {
        templateId: route.id,
        code: 'BAD',
        nameEn: 'From Edfu',
        nameAr: 'من إدفو',
        embarkStopSeq: 1,
        disembarkStopSeq: 2,
      }),
    ).rejects.toMatchObject({ details: { problems: ['embark_not_boarding'] } });

    const edit = () =>
      replaceRouteStops(db, ctx, {
        routeId: route.id,
        cycleDays: 7,
        validFrom: monday,
        stops: weekly().map((s) => (s.portId === port.EDF ? { ...s, portId: port.KOM! } : s)),
      });
    await expect(edit()).rejects.toMatchObject({ details: { reason: 'route_in_use' } });
    await deleteItinerary(db, ctx, itinerary.id);
    await expect(edit()).resolves.toMatchObject({ cycle_days: 7 });

    await addItinerary(db, ctx, {
      templateId: route.id,
      code: 'ASW-3',
      nameEn: '3 nights from Aswan',
      nameAr: '٣ ليالٍ من أسوان',
      embarkStopSeq: 2,
      disembarkStopSeq: 3,
    });
    await addItinerary(db, ctx, {
      templateId: route.id,
      code: 'LXR-7',
      nameEn: '7 nights from Luxor',
      nameAr: '٧ ليالٍ من الأقصر',
      embarkStopSeq: 0,
      disembarkStopSeq: 3,
    });
    await expect(
      addItinerary(db, ctx, {
        templateId: route.id,
        code: 'ASW-3',
        nameEn: 'x',
        nameAr: 'x',
        embarkStopSeq: 2,
        disembarkStopSeq: 3,
      }),
    ).rejects.toMatchObject({ details: { reason: 'code_taken' } });
  });

  it('after generation: departures and sailings exist, and the route stops cannot change', async () => {
    const generated = await generateSchedule(db, ctx, {
      vesselId,
      until: addDays(monday as never, 27),
    });
    expect(generated.legsCreated).toBe(8);
    expect(generated.sailingsCreated).toBe(8);

    const { routes } = await getRoutes(db, ctx, vesselId);
    const route = routes[0]!;
    expect(route).toMatchObject({ name: 'Luxor ⇄ Aswan', legs: 8, upcomingLegs: 8 });
    expect(route.stops.map((s) => s.portId)).toEqual([port.LXR, port.KOM, port.ASW, port.LXR]);
    expect(route.itineraries.map((i) => [i.code, i.nights, i.sailings])).toEqual([
      ['ASW-3', 3, 4],
      ['LXR-7', 7, 4],
    ]);

    await expect(deleteRoute(db, ctx, route.id)).rejects.toMatchObject({
      details: { reason: 'route_in_use' },
    });
    await expect(deleteItinerary(db, ctx, route.itineraries[0]!.id)).rejects.toMatchObject({
      details: { reason: 'itinerary_in_use' },
    });

    // Ending the route: no cycles after that date; earlier departures stay.
    await expect(
      updateRoute(db, ctx, { routeId: route.id, name: 'x', validTo: addDays(monday as never, -1) }),
    ).rejects.toMatchObject({ details: { problems: ['ends_before_start'] } });
    await updateRoute(db, ctx, {
      routeId: route.id,
      name: 'Luxor ⇄ Aswan (summer)',
      validTo: addDays(monday as never, 7),
    });
    const more = await generateSchedule(db, ctx, { vesselId, until: addDays(monday as never, 60) });
    expect(more.legsCreated).toBe(0);

    const paused = await updateItinerary(db, ctx, {
      itineraryId: route.itineraries[1]!.id,
      nameEn: '7 nights from Luxor',
      nameAr: '٧ ليالٍ من الأقصر',
      active: false,
    });
    expect(paused.active).toBe(false);
  });

  it('a port on a running route cannot be retired; an unused one can', async () => {
    await expect(
      updatePort(db, ctx, { portId: port.ASW!, nameEn: 'Aswan', nameAr: 'أسوان', active: false }),
    ).rejects.toMatchObject({ details: { reason: 'port_in_use' } });
    const retired = await updatePort(db, ctx, {
      portId: port.CAI!,
      nameEn: 'Cairo',
      nameAr: 'القاهرة',
      active: false,
    });
    expect(retired.active).toBe(false);
    await expect(
      addRoute(db, ctx, {
        vesselId,
        name: 'Via Cairo',
        cycleDays: 7,
        validFrom: addDays(monday as never, 70),
        stops: [
          { portId: port.CAI!, dayOffset: 0, embarkAllowed: true, disembarkAllowed: true },
          { portId: port.CAI!, dayOffset: 7, embarkAllowed: true, disembarkAllowed: true },
        ],
      }),
    ).rejects.toMatchObject({ details: { problems: ['inactive_port'] } });
  });

  it('a route with nothing on it can be deleted', async () => {
    const route = await addRoute(db, ctx, {
      vesselId,
      name: 'Draft',
      cycleDays: 7,
      validFrom: addDays(monday as never, 140),
      stops: weekly(),
    });
    await deleteRoute(db, ctx, route.id);
    const { routes } = await getRoutes(db, ctx, vesselId);
    expect(routes.map((r) => r.name)).not.toContain('Draft');
  });
});
