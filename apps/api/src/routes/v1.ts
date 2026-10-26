import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import {
  acceptOffer,
  applyAmendment,
  assertOwnedBy,
  bookingIdForChannel,
  cancelBooking,
  channelAvailability,
  confirmHold,
  consumeRateLimit,
  createHold,
  createQuote,
  createRequest,
  getBookingView,
  getHoldView,
  listChannelEvents,
  listChannelVessels,
  listSailings,
  quoteAmendment,
  releaseHold,
  upsertGuests,
  type EngineContext,
  DIETARY,
  GUEST_TITLES,
  OCCASIONS,
  VISA_TYPES,
  type GuestInput,
  type VsDatabase,
} from '@vs/engine';
import { verifyToken, type ChannelPrincipal } from '../auth';
import * as present from '../presenters';

declare module 'fastify' {
  interface FastifyRequest {
    principal: ChannelPrincipal;
    engine: EngineContext;
  }
}

export interface V1Options {
  db: VsDatabase;
  tokenSecret: Uint8Array;
  /** Test hook (spec test 6): runs after a write has committed and before the response is sent. */
  afterCommit?: (route: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Request bodies (strict: unknown fields are refused)
// ---------------------------------------------------------------------------
const id = z.uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const cabin = z
  .object({
    category_id: id,
    adults: z.number().int().min(1).max(10),
    child_ages: z.array(z.number().int().min(0).max(17)).optional(),
    child_birth_dates: z.array(date).optional(),
  })
  .strict();
const guest = z
  .object({
    cabin: z.number().int().min(0),
    first_name: z.string().min(1).max(100),
    last_name: z.string().min(1).max(100),
    nationality: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    date_of_birth: date.optional(),
    passport_number: z.string().min(3).max(30).optional(),
    lead: z.boolean().optional(),
    // Check-in details (optional): what the vessel's reception and police list need.
    title: z.enum(GUEST_TITLES).optional(),
    gender: z.enum(['female', 'male']).optional(),
    passport_country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    passport_issued_on: date.optional(),
    passport_expires_on: date.optional(),
    place_of_birth: z.string().min(1).max(100).optional(),
    visa_type: z.enum(VISA_TYPES).optional(),
    visa_number: z.string().min(3).max(40).optional(),
    arrival_date: date.optional(),
    arrival_flight: z.string().min(1).max(20).optional(),
    arrival_port: z.string().min(1).max(100).optional(),
    phone: z.string().min(3).max(30).optional(),
    emergency_name: z.string().min(1).max(100).optional(),
    emergency_phone: z.string().min(3).max(30).optional(),
    dietary: z.array(z.enum(DIETARY)).max(DIETARY.length).optional(),
    allergies: z.string().min(1).max(300).optional(),
    medical_notes: z.string().min(1).max(500).optional(),
    occasion: z.enum(OCCASIONS).optional(),
    occasion_date: date.optional(),
  })
  .strict();
const bodies = {
  quote: z
    .object({
      sailing_id: id,
      market: z.string().min(2).max(32),
      rate_plan_id: id.optional(),
      cabins: z.array(cabin).min(1).max(20),
    })
    .strict(),
  hold: z.object({ quote_id: id, kind: z.enum(['checkout', 'option']) }).strict(),
  confirm: z
    .object({ channel_ref: z.string().min(1).max(100).optional(), guests: z.array(guest).min(1) })
    .strict(),
  request: z
    .object({
      quote_id: id,
      channel_ref: z.string().min(1).max(100).optional(),
      guests: z.array(guest).optional(),
    })
    .strict(),
  amendmentQuote: z
    .object({ sailing_id: id.optional(), cabins: z.array(cabin).min(1).max(20).optional() })
    .strict(),
  amendment: z.object({ amendment_quote_id: id }).strict(),
  cancel: z.object({ reason: z.string().min(1).max(500) }).strict(),
  guests: z.object({ guests: z.array(guest).min(1) }).strict(),
};
const queries = {
  vessel: z.object({ vessel: id, from: date, to: date }).strict(),
  sailings: z
    .object({ vessel: id, from: date, to: date, nights: z.coerce.number().int().min(1).optional() })
    .strict(),
  events: z
    .object({
      after: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    })
    .strict(),
};

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new DomainError('VALIDATION_FAILED', {
      details: {
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }
  return result.data;
}

const toCabins = (cabins: z.infer<typeof cabin>[]) =>
  cabins.map((c) => ({
    categoryId: c.category_id,
    adults: c.adults,
    childAges: c.child_ages ?? [],
    childBirthDates: c.child_birth_dates ?? [],
  }));
const toGuests = (guests: z.infer<typeof guest>[]): GuestInput[] =>
  guests.map((g) => ({
    cabin: g.cabin,
    firstName: g.first_name,
    lastName: g.last_name,
    nationality: g.nationality,
    dateOfBirth: g.date_of_birth as GuestInput['dateOfBirth'],
    passportNumber: g.passport_number,
    lead: g.lead ?? false,
    title: g.title,
    gender: g.gender,
    passportCountry: g.passport_country,
    passportIssuedOn: g.passport_issued_on as GuestInput['passportIssuedOn'],
    passportExpiresOn: g.passport_expires_on as GuestInput['passportExpiresOn'],
    placeOfBirth: g.place_of_birth,
    visaType: g.visa_type,
    visaNumber: g.visa_number,
    arrivalDate: g.arrival_date as GuestInput['arrivalDate'],
    arrivalFlight: g.arrival_flight,
    arrivalPort: g.arrival_port,
    phone: g.phone,
    emergencyName: g.emergency_name,
    emergencyPhone: g.emergency_phone,
    dietary: g.dietary,
    allergies: g.allergies,
    medicalNotes: g.medical_notes,
    occasion: g.occasion,
    occasionDate: g.occasion_date as GuestInput['occasionDate'],
  }));

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 1 || key.length > 255) {
    throw new DomainError('VALIDATION_FAILED', {
      message: 'The Idempotency-Key header is required on writes (1–255 characters)',
    });
  }
  return key;
}

export async function v1Routes(app: FastifyInstance, options: V1Options) {
  const { db } = options;
  const committed = async (route: string) => options.afterCommit?.(route);

  // Every /v1 call: a valid token, then the client's rate limit.
  app.addHook('onRequest', async (request, reply) => {
    const principal = await verifyToken(options.tokenSecret, request.headers.authorization);
    request.principal = principal;
    request.engine = {
      operatorId: principal.operatorId,
      actor: { type: 'channel', id: principal.channelId, label: 'channel-api' },
    };
    const limit = await consumeRateLimit(db, request.engine, principal.apiClientId);
    void reply
      .header('X-RateLimit-Limit', limit.limit)
      .header('X-RateLimit-Remaining', limit.remaining);
    if (!limit.allowed) {
      void reply.header('Retry-After', limit.retryAfter);
      throw new DomainError('RATE_LIMITED');
    }
  });

  const bookingResponse = async (
    request: FastifyRequest,
    reply: FastifyReply,
    bookingId: string,
    status: number,
    extra: { reason?: string } = {},
  ) => {
    const view = await getBookingView(db, request.engine, bookingId);
    return reply
      .status(status)
      .header('ETag', `"${view.revision}"`)
      .send(present.booking(view, extra));
  };

  app.get('/vessels', async (request) => {
    const vessels = await listChannelVessels(db, request.engine, request.principal.channelId);
    return {
      vessels: vessels.map((v) => ({
        id: v.vessel.id,
        code: v.vessel.code,
        name: v.vessel.name,
        type: v.vessel.type,
        max_guests: v.vessel.max_guests,
        allocation: v.allocation,
        categories: v.categories.map((c) => ({
          id: c.id,
          code: c.code,
          name: { en: c.name_en, ar: c.name_ar },
          deck: c.deck,
          bed_config: c.bed_config,
          max_adults: c.max_adults,
          max_occupancy: c.max_occupancy,
        })),
        rate_plans: v.plans,
      })),
    };
  });

  app.get('/sailings', async (request) => {
    const q = parse(queries.sailings, request.query);
    const sailings = await listSailings(db, request.engine, {
      channelId: request.principal.channelId,
      vesselId: q.vessel,
      from: q.from,
      to: q.to,
      nights: q.nights,
    });
    return { sailings: sailings.map(present.sailing) };
  });

  app.get('/availability', async (request) => {
    const q = parse(queries.vessel, request.query);
    return present.availability(
      await channelAvailability(db, request.engine, {
        channelId: request.principal.channelId,
        vesselId: q.vessel,
        from: q.from,
        to: q.to,
      }),
    );
  });

  app.post('/quotes', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.quote, request.body);
    const quote = await createQuote(
      db,
      request.engine,
      {
        channelId: request.principal.channelId,
        sailingId: body.sailing_id,
        market: body.market,
        ratePlanId: body.rate_plan_id,
        cabins: toCabins(body.cabins),
      },
      { requestKey: key },
    );
    await committed('quotes');
    return reply.status(201).send(present.quote(quote));
  });

  app.post('/holds', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.hold, request.body);
    const hold = await createHold(db, request.engine, {
      channelId: request.principal.channelId,
      quoteId: body.quote_id,
      kind: body.kind,
      requestKey: key,
    });
    await committed('holds');
    return reply.status(201).send(present.hold(await getHoldView(db, request.engine, hold.holdId)));
  });

  app.delete<{ Params: { id: string } }>('/holds/:id', async (request) => {
    const key = idempotencyKey(request);
    const holdId = parse(id, request.params.id);
    await assertOwnedBy(db, request.engine, request.principal.channelId, 'hold', holdId);
    await releaseHold(db, request.engine, { holdId, requestKey: key });
    await committed('holds.release');
    return present.hold(await getHoldView(db, request.engine, holdId));
  });

  app.post<{ Params: { id: string } }>('/holds/:id/confirm', async (request, reply) => {
    const key = idempotencyKey(request);
    const holdId = parse(id, request.params.id);
    const body = parse(bodies.confirm, request.body);
    await assertOwnedBy(db, request.engine, request.principal.channelId, 'hold', holdId);
    const result = await confirmHold(db, request.engine, {
      holdId,
      guests: toGuests(body.guests),
      channelRef: body.channel_ref,
      requestKey: key,
    });
    await committed('holds.confirm');
    return bookingResponse(request, reply, result.bookingId, 201, { reason: result.reason });
  });

  app.post('/requests', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.request, request.body);
    const result = await createRequest(db, request.engine, {
      channelId: request.principal.channelId,
      quoteId: body.quote_id,
      channelRef: body.channel_ref,
      guests: body.guests ? toGuests(body.guests) : undefined,
      requestKey: key,
    });
    await committed('requests');
    return bookingResponse(request, reply, result.bookingId, 201);
  });

  app.post<{ Params: { id: string } }>('/offers/:id/accept', async (request, reply) => {
    const key = idempotencyKey(request);
    const offerId = parse(id, request.params.id);
    await assertOwnedBy(db, request.engine, request.principal.channelId, 'offer', offerId);
    const result = await acceptOffer(db, request.engine, { offerId, requestKey: key });
    await committed('offers.accept');
    return bookingResponse(request, reply, result.bookingId, 200);
  });

  app.get<{ Params: { ref: string } }>('/bookings/:ref', async (request, reply) => {
    const bookingId = await bookingIdForChannel(
      db,
      request.engine,
      request.principal.channelId,
      request.params.ref,
    );
    return bookingResponse(request, reply, bookingId, 200);
  });

  app.post<{ Params: { ref: string } }>(
    '/bookings/:ref/amendment-quotes',
    async (request, reply) => {
      const key = idempotencyKey(request);
      const body = parse(bodies.amendmentQuote, request.body);
      const bookingId = await bookingIdForChannel(
        db,
        request.engine,
        request.principal.channelId,
        request.params.ref,
      );
      const result = await quoteAmendment(db, request.engine, {
        bookingId,
        sailingId: body.sailing_id,
        cabins: body.cabins ? toCabins(body.cabins) : undefined,
        requestKey: key,
      });
      await committed('amendment-quotes');
      const currency = result.quote.currency;
      return reply.status(201).send({
        quote: present.quote(result.quote),
        revision: result.revision,
        changes: result.changes,
        fee: present.money(result.fee, currency),
        difference: present.money(result.difference, currency),
      });
    },
  );

  app.post<{ Params: { ref: string } }>('/bookings/:ref/amendments', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.amendment, request.body);
    const ifMatch = /^"?(\d+)"?$/.exec(String(request.headers['if-match'] ?? ''));
    if (!ifMatch)
      throw new DomainError('VALIDATION_FAILED', {
        message: 'If-Match with the booking revision is required',
      });
    const bookingId = await bookingIdForChannel(
      db,
      request.engine,
      request.principal.channelId,
      request.params.ref,
    );
    await applyAmendment(db, request.engine, {
      bookingId,
      revision: Number(ifMatch[1]),
      amendmentQuoteId: body.amendment_quote_id,
      requestKey: key,
    });
    await committed('amendments');
    return bookingResponse(request, reply, bookingId, 200);
  });

  app.post<{ Params: { ref: string } }>('/bookings/:ref/cancel', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.cancel, request.body);
    const bookingId = await bookingIdForChannel(
      db,
      request.engine,
      request.principal.channelId,
      request.params.ref,
    );
    await cancelBooking(db, request.engine, { bookingId, reason: body.reason, requestKey: key });
    await committed('cancel');
    return bookingResponse(request, reply, bookingId, 200);
  });

  app.patch<{ Params: { ref: string } }>('/bookings/:ref/guests', async (request, reply) => {
    const key = idempotencyKey(request);
    const body = parse(bodies.guests, request.body);
    const bookingId = await bookingIdForChannel(
      db,
      request.engine,
      request.principal.channelId,
      request.params.ref,
    );
    await upsertGuests(db, request.engine, {
      bookingId,
      guests: toGuests(body.guests),
      requestKey: key,
    });
    await committed('guests');
    return bookingResponse(request, reply, bookingId, 200);
  });

  app.get('/events', async (request) => {
    const q = parse(queries.events, request.query);
    const page = await listChannelEvents(db, request.engine, {
      channelId: request.principal.channelId,
      after: q.after,
      limit: q.limit,
    });
    return { events: page.events.map(present.event), next_cursor: page.nextCursor };
  });
}
