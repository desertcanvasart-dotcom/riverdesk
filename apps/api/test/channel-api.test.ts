import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import {
  addApiClientSecret,
  createApiClient,
  createChannel,
  createContract,
  createDemoPricing,
  createDemoVessel,
  generateSchedule,
  openDatabase,
  revokeApiClientSecret,
  type VsDatabase,
} from '@vs/engine';
import { addDays, createLogger, systemActor, type BusinessDate } from '@vs/shared';
import { buildApp } from '../src/app';

const logger = createLogger('api-test', { level: 'silent' });
const tokenSecret = Buffer.alloc(32, 7);

describe('channel API v1', () => {
  let db: VsDatabase;
  let operatorId: string;
  let M: BusinessDate;
  let vesselId: string;
  let categories: Record<string, string>;
  let nilecrz: {
    clientId: string;
    secret: string;
    apiClientId: string;
    channelId: string;
    contractId: string;
  };
  let agent: { clientId: string; secret: string; channelId: string };
  let app: ReturnType<typeof buildApp>;
  const tokens = new Map<string, string>();

  const ctx = () => ({ operatorId, actor: systemActor('test') });

  beforeAll(async () => {
    db = openDatabase('vs_api', { config: testConfig(), max: 25 });
    const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
    operatorId = await createOperator('API test operator');
    const demo = await createDemoVessel(backoffice, ctx());
    vesselId = demo.vesselId;
    categories = demo.categories;
    M = demo.validFrom;
    await generateSchedule(backoffice, ctx(), { vesselId, until: addDays(M, 70) });
    const pricing = await createDemoPricing(backoffice, ctx(), vesselId);
    const client = await createApiClient(backoffice, ctx(), {
      channelId: pricing.channels.nilecrz,
      name: 'nilecrz',
    });
    const contract = await owner().query<{ id: string }>(
      `select id from vs.channel_contract where channel_id = $1`,
      [pricing.channels.nilecrz],
    );
    nilecrz = { ...client, channelId: pricing.channels.nilecrz, contractId: contract.rows[0]!.id };
    const other = await createChannel(backoffice, ctx(), {
      code: 'other-portal',
      name: 'Other portal',
      type: 'portal',
    });
    await createContract(backoffice, ctx(), {
      channelId: other.id,
      vesselId,
      allocation: 'pool',
      paymentMode: 'channel_collected',
      validFrom: M,
      categoryIds: [categories.STD!],
      ratePlanIds: pricing.ratePlanIds,
      checkoutHoldMinutes: 10,
    });
    agent = {
      ...(await createApiClient(backoffice, ctx(), { channelId: other.id, name: 'other' })),
      channelId: other.id,
    };
    await backoffice.close();
    app = buildApp({ db, logger, tokenSecret });
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  async function token(client: { clientId: string; secret: string }) {
    const cached = tokens.get(client.clientId);
    if (cached) return cached;
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: {
        authorization: `Basic ${Buffer.from(`${client.clientId}:${client.secret}`).toString('base64')}`,
      },
      payload: { grant_type: 'client_credentials' },
    });
    expect(res.statusCode).toBe(200);
    tokens.set(client.clientId, res.json().access_token);
    return res.json().access_token as string;
  }

  let keyCounter = 0;
  async function call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    options: {
      body?: unknown;
      key?: string | null;
      as?: { clientId: string; secret: string };
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await token(options.as ?? nilecrz)}`,
      ...options.headers,
    };
    if (method !== 'GET' && options.key !== null)
      headers['idempotency-key'] = options.key ?? `k-${Date.now()}-${keyCounter++}`;
    return app.inject({
      method,
      url,
      headers,
      ...(options.body !== undefined ? { payload: options.body as object } : {}),
    });
  }

  async function sailing(pattern: string, offset: number) {
    const res = await call(
      'GET',
      `/v1/sailings?vessel=${vesselId}&from=${addDays(M, offset)}&to=${addDays(M, offset)}`,
    );
    return (res.json().sailings as { id: string; pattern_code: string }[]).find(
      (s) => s.pattern_code === pattern,
    )!.id;
  }
  async function quote(
    sailingId: string,
    cabins: { category_id: string; adults: number; child_ages?: number[] }[],
    as: { clientId: string; secret: string } = nilecrz,
  ) {
    return call('POST', '/v1/quotes', {
      body: { sailing_id: sailingId, market: 'international', cabins },
      as,
    });
  }
  const lead = [
    {
      cabin: 0,
      first_name: 'Emma',
      last_name: 'Clarke',
      lead: true,
      passport_number: 'P12345678',
      date_of_birth: '1985-04-02',
    },
  ];

  describe('auth', () => {
    it('client credentials: Basic or form; wrong secrets and tokens are refused', async () => {
      const form = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: `grant_type=client_credentials&client_id=${nilecrz.clientId}&client_secret=${nilecrz.secret}`,
      });
      expect(form.json()).toMatchObject({ token_type: 'Bearer', expires_in: 900 });
      const wrong = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'client_credentials',
          client_id: nilecrz.clientId,
          client_secret: 'vss_wrong-secret',
        },
      });
      expect([wrong.statusCode, wrong.json()]).toEqual([401, { error: 'invalid_client' }]);
      const grant = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: { grant_type: 'password' },
      });
      expect(grant.json()).toEqual({ error: 'unsupported_grant_type' });

      const none = await app.inject({ method: 'GET', url: '/v1/vessels' });
      expect([none.statusCode, none.json().error.code]).toEqual([401, 'UNAUTHENTICATED']);
      const forged = await app.inject({
        method: 'GET',
        url: '/v1/vessels',
        headers: { authorization: `Bearer ${(await token(nilecrz)).slice(0, -3)}abc` },
      });
      expect(forged.statusCode).toBe(401);
    });

    it('two secrets can be active for rotation; a revoked one stops working', async () => {
      const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 1 });
      const second = await addApiClientSecret(backoffice, ctx(), {
        apiClientId: nilecrz.apiClientId,
      });
      const both = await Promise.all(
        [nilecrz.secret, second.secret].map((secret) =>
          app.inject({
            method: 'POST',
            url: '/oauth/token',
            payload: {
              grant_type: 'client_credentials',
              client_id: nilecrz.clientId,
              client_secret: secret,
            },
          }),
        ),
      );
      expect(both.map((r) => r.statusCode)).toEqual([200, 200]);
      await revokeApiClientSecret(backoffice, ctx(), { secretId: second.secretId });
      const revoked = await app.inject({
        method: 'POST',
        url: '/oauth/token',
        payload: {
          grant_type: 'client_credentials',
          client_id: nilecrz.clientId,
          client_secret: second.secret,
        },
      });
      expect(revoked.statusCode).toBe(401);
      await backoffice.close();
    });
  });

  describe('catalogue and availability', () => {
    it('lists only contracted vessels, categories and plans', async () => {
      const mine = (await call('GET', '/v1/vessels')).json();
      expect(mine.vessels[0].categories.map((c: { code: string }) => c.code)).toEqual([
        'STD',
        'SUP',
        'JS',
        'RS',
      ]);
      const theirs = (await call('GET', '/v1/vessels', { as: agent })).json();
      expect(theirs.vessels[0].categories.map((c: { code: string }) => c.code)).toEqual(['STD']);
    });

    it('availability: per sailing and contracted category, capped, with a from-price', async () => {
      const res = await call(
        'GET',
        `/v1/availability?vessel=${vesselId}&from=${M}&to=${addDays(M, 6)}`,
      );
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.as_of).toBeTruthy();
      const lxr4 = body.sailings.find((s: { pattern_code: string }) => s.pattern_code === 'LXR-4');
      expect(lxr4.categories.find((c: { code: string }) => c.code === 'STD')).toMatchObject({
        status: 'instant',
        free: 12,
        from_price: { currency: 'USD' },
      });
      await owner().query(`update vs.channel_contract set visible_free_cap = 3 where id = $1`, [
        nilecrz.contractId,
      ]);
      const capped = (
        await call('GET', `/v1/availability?vessel=${vesselId}&from=${M}&to=${M}`)
      ).json();
      expect(
        Math.max(
          ...capped.sailings.flatMap((s: { categories: { free: number }[] }) =>
            s.categories.map((c) => c.free),
          ),
        ),
      ).toBe(3);
      await owner().query(`update vs.channel_contract set visible_free_cap = null where id = $1`, [
        nilecrz.contractId,
      ]);
    });

    it('a vessel outside the contract is refused; bad queries are 400', async () => {
      const res = await call(
        'GET',
        `/v1/availability?vessel=${crypto.randomUUID()}&from=${M}&to=${M}`,
      );
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'CONTRACT_FORBIDS']);
      const bad = await call(
        'GET',
        `/v1/availability?vessel=${vesselId}&from=${M}&to=${M}&extra=1`,
      );
      expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  describe('booking flow', () => {
    it('quote → hold → confirm → read → amend (If-Match) → cancel, without leaking personal data', async () => {
      const sailingId = await sailing('LXR-7', 21);
      const q = await quote(sailingId, [
        { category_id: categories.STD!, adults: 2, child_ages: [7] },
      ]);
      expect(q.statusCode).toBe(201);
      expect(q.json()).toMatchObject({
        currency: 'USD',
        total: { currency: 'USD' },
        rate_plan: { code: 'INTL' },
      });
      const hold = await call('POST', '/v1/holds', {
        body: { quote_id: q.json().id, kind: 'checkout' },
      });
      expect(hold.json()).toMatchObject({ kind: 'checkout', status: 'active' });
      const confirmed = await call('POST', `/v1/holds/${hold.json().id}/confirm`, {
        body: { channel_ref: 'NC-E2E-1', guests: lead },
      });
      expect(confirmed.statusCode).toBe(201);
      const booking = confirmed.json();
      expect(booking).toMatchObject({
        status: 'confirmed',
        revision: 1,
        channel_ref: 'NC-E2E-1',
        cabins: [{ category_code: 'STD', guests: [{ first_name: 'Emma', lead: true }] }],
      });
      expect(JSON.stringify(booking)).not.toMatch(/P12345678|1985-04-02/);

      const read = await call('GET', `/v1/bookings/${booking.ref}`);
      expect(read.headers.etag).toBe('"1"');
      const change = await call('POST', `/v1/bookings/${booking.ref}/amendment-quotes`, {
        body: { sailing_id: await sailing('LXR-4', 21) },
      });
      expect(change.json()).toMatchObject({ revision: 1, changes: ['date'] });
      const stale = await call('POST', `/v1/bookings/${booking.ref}/amendments`, {
        body: { amendment_quote_id: change.json().quote.id },
        headers: { 'if-match': '"7"' },
      });
      expect([stale.statusCode, stale.json().error.code]).toEqual([409, 'REVISION_CHANGED']);
      const amended = await call('POST', `/v1/bookings/${booking.ref}/amendments`, {
        body: { amendment_quote_id: change.json().quote.id },
        headers: { 'if-match': '"1"' },
      });
      expect(amended.json()).toMatchObject({ revision: 2, sailing: { pattern_code: 'LXR-4' } });
      const cancelled = await call('POST', `/v1/bookings/${booking.ref}/cancel`, {
        body: { reason: 'Guest cancelled' },
      });
      expect(cancelled.json()).toMatchObject({ status: 'cancelled', penalty: { currency: 'USD' } });
    });

    it('requests: an on-request booking is created without cabins', async () => {
      const q = await quote(await sailing('ASW-3', 25), [
        { category_id: categories.SUP!, adults: 2 },
      ]);
      const res = await call('POST', '/v1/requests', {
        body: { quote_id: q.json().id, channel_ref: 'NC-REQ-1' },
      });
      expect(res.json()).toMatchObject({ status: 'requested', channel_ref: 'NC-REQ-1' });
      expect(res.json().request_expires_at).toBeTruthy();
    });

    it("another channel cannot see or act on nilecrz's bookings and holds", async () => {
      const q = await quote(await sailing('LXR-4', 28), [
        { category_id: categories.STD!, adults: 2 },
      ]);
      const hold = await call('POST', '/v1/holds', {
        body: { quote_id: q.json().id, kind: 'option' },
      });
      const notMine = await call('POST', `/v1/holds/${hold.json().id}/confirm`, {
        body: { guests: lead },
        as: agent,
      });
      expect([notMine.statusCode, notMine.json().error.code]).toEqual([404, 'NOT_FOUND']);
      const booking = (
        await call('POST', `/v1/holds/${hold.json().id}/confirm`, { body: { guests: lead } })
      ).json();
      const read = await call('GET', `/v1/bookings/${booking.ref}`, { as: agent });
      expect(read.statusCode).toBe(404);
      const events = (await call('GET', '/v1/events?limit=500', { as: agent })).json();
      expect(
        events.events.some(
          (e: { resource_id: string; type: string }) => e.type === 'booking.confirmed',
        ),
      ).toBe(false);
    });
  });

  describe('contract enforcement', () => {
    it('refuses a category outside the contract, and holds use the contract TTL', async () => {
      const sailingId = await sailing('LXR-4', 35);
      const forbidden = await quote(sailingId, [{ category_id: categories.JS!, adults: 2 }], agent);
      expect([forbidden.statusCode, forbidden.json().error.code]).toEqual([
        403,
        'CONTRACT_FORBIDS',
      ]);
      const q = await quote(sailingId, [{ category_id: categories.STD!, adults: 2 }], agent);
      const hold = (
        await call('POST', '/v1/holds', {
          body: { quote_id: q.json().id, kind: 'checkout' },
          as: agent,
        })
      ).json();
      const minutes = Math.round((Date.parse(hold.expires_at) - Date.now()) / 60_000);
      expect(minutes).toBe(10); // this contract's checkout TTL, not the 30-minute default
      const ttlField = await call('POST', '/v1/holds', {
        body: { quote_id: q.json().id, kind: 'checkout', ttl_minutes: 600 },
        as: agent,
      });
      expect([ttlField.statusCode, ttlField.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  describe('idempotency (spec test 5)', () => {
    it('writes need a key; a repeat replays; a different body with the same key is 422', async () => {
      const sailingId = await sailing('ASW-3', 32);
      const missing = await call('POST', '/v1/quotes', {
        body: {
          sailing_id: sailingId,
          market: 'international',
          cabins: [{ category_id: categories.STD!, adults: 2 }],
        },
        key: null,
      });
      expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'VALIDATION_FAILED']);
      const body = {
        sailing_id: sailingId,
        market: 'international',
        cabins: [{ category_id: categories.STD!, adults: 2 }],
      };
      const first = await call('POST', '/v1/quotes', { body, key: 'quote-key-1' });
      const again = await call('POST', '/v1/quotes', { body, key: 'quote-key-1' });
      expect(again.json().id).toBe(first.json().id);
      const other = await call('POST', '/v1/quotes', {
        body: { ...body, cabins: [{ category_id: categories.SUP!, adults: 2 }] },
        key: 'quote-key-1',
      });
      expect([other.statusCode, other.json().error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    });

    it('the same Idempotency-Key 10 times at once → one booking; the same channel_ref after the key expired → the existing booking', async () => {
      const sailingId = await sailing('LXR-4', 42);
      const q = await quote(sailingId, [{ category_id: categories.STD!, adults: 2 }]);
      const hold = (
        await call('POST', '/v1/holds', { body: { quote_id: q.json().id, kind: 'option' } })
      ).json();
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          call('POST', `/v1/holds/${hold.id}/confirm`, {
            body: { channel_ref: 'NC-DUP-1', guests: lead },
            key: 'confirm-dup-1',
          }),
        ),
      );
      const codes = responses.map((r) => r.statusCode);
      expect(codes.every((c) => c === 201 || c === 409)).toBe(true);
      expect(codes.filter((c) => c === 201).length).toBeGreaterThanOrEqual(1);
      expect(
        responses
          .filter((r) => r.statusCode === 409)
          .every((r) => r.json().error.code === 'IN_PROGRESS' && r.headers['retry-after']),
      ).toBe(true);
      const refs = new Set(responses.filter((r) => r.statusCode === 201).map((r) => r.json().ref));
      expect(refs.size).toBe(1);
      const count = await owner().query(
        `select count(*)::int as n from vs.booking where channel_ref = 'NC-DUP-1' and operator_id = $1`,
        [operatorId],
      );
      expect(count.rows[0].n).toBe(1);

      // Seven days later the key is gone, but channel_ref still finds the booking.
      await owner().query(
        `update vs.idempotency_key set expires_at = now() - interval '1 second' where key = 'confirm-dup-1'`,
      );
      const q2 = await quote(sailingId, [{ category_id: categories.STD!, adults: 2 }]);
      const hold2 = (
        await call('POST', '/v1/holds', { body: { quote_id: q2.json().id, kind: 'option' } })
      ).json();
      const repeat = await call('POST', `/v1/holds/${hold2.id}/confirm`, {
        body: { channel_ref: 'NC-DUP-1', guests: lead },
        key: 'confirm-dup-1',
      });
      expect(repeat.json().ref).toBe([...refs][0]);
      const after = await owner().query(
        `select count(*)::int as n from vs.booking where channel_ref = 'NC-DUP-1' and operator_id = $1`,
        [operatorId],
      );
      expect(after.rows[0].n).toBe(1);
      await call('DELETE', `/v1/holds/${hold2.id}`);
    });
  });

  it('spec test 6: a crash after commit and before the response; the retry with the same key returns the committed result', async () => {
    let crash = true;
    const crashing = buildApp({
      db,
      logger,
      tokenSecret,
      afterCommit: () => {
        if (crash) {
          crash = false;
          throw new Error('simulated crash after commit');
        }
      },
    });
    const sailingId = await sailing('LXR-4', 49);
    const q = await quote(sailingId, [{ category_id: categories.STD!, adults: 2 }]);
    const hold = (
      await call('POST', '/v1/holds', { body: { quote_id: q.json().id, kind: 'option' } })
    ).json();
    const headers = {
      authorization: `Bearer ${await token(nilecrz)}`,
      'idempotency-key': 'crash-key-1',
    };
    const payload = { channel_ref: 'NC-CRASH-1', guests: lead };
    const first = await crashing.inject({
      method: 'POST',
      url: `/v1/holds/${hold.id}/confirm`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(500);
    const retry = await crashing.inject({
      method: 'POST',
      url: `/v1/holds/${hold.id}/confirm`,
      headers,
      payload,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json()).toMatchObject({ status: 'confirmed', channel_ref: 'NC-CRASH-1' });
    const count = await owner().query(
      `select count(*)::int as n from vs.booking where channel_ref = 'NC-CRASH-1' and operator_id = $1`,
      [operatorId],
    );
    expect(count.rows[0].n).toBe(1);
    await crashing.close();
  });

  it('events: own events in commit order, paged with a cursor, without personal data', async () => {
    const page1 = (await call('GET', '/v1/events?limit=5')).json();
    expect(page1.events).toHaveLength(5);
    const page2 = (await call('GET', `/v1/events?limit=500&after=${page1.next_cursor}`)).json();
    const ids = new Set(page1.events.map((e: { event_id: string }) => e.event_id));
    expect(page2.events.some((e: { event_id: string }) => ids.has(e.event_id))).toBe(false);
    const all = [...page1.events, ...page2.events];
    expect(all.some((e: { type: string }) => e.type === 'booking.confirmed')).toBe(true);
    expect(JSON.stringify(all)).not.toMatch(/P12345678|1985-04-02|passport|date_of_birth/);
    const end = (await call('GET', `/v1/events?after=${page2.next_cursor}`)).json();
    expect(end.events).toEqual([]);
  });

  it('rate limit: 429 with Retry-After once the minute is used up', async () => {
    const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 1 });
    const tight = await createApiClient(backoffice, ctx(), {
      channelId: nilecrz.channelId,
      name: 'tight',
      rateLimitPerMinute: 3,
    });
    await backoffice.close();
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await call('GET', '/v1/vessels', { as: tight }));
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200, 429]);
    expect(results[3]!.headers['retry-after']).toBeTruthy();
    expect(results[3]!.json().error.code).toBe('RATE_LIMITED');
  });

  it('a lost database connection is 503 with Retry-After', async () => {
    const broken = openDatabase('vs_api', {
      config: { ...testConfig(), DATABASE_PORT: 1 },
      max: 1,
    });
    const down = buildApp({ db: broken, logger, tokenSecret });
    const res = await down.inject({
      method: 'GET',
      url: '/v1/vessels',
      headers: { authorization: `Bearer ${await token(nilecrz)}` },
    });
    expect([res.statusCode, res.headers['retry-after'], res.json().error.code]).toEqual([
      503,
      '30',
      'SERVICE_UNAVAILABLE',
    ]);
    await down.close();
    await broken.close();
  });
});
