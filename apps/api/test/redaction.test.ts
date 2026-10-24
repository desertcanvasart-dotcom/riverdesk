import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import {
  claimDueDeliveries,
  createApiClient,
  createDemoPricing,
  createDemoVessel,
  createWebhookEndpoint,
  dispatchWebhooks,
  eventJson,
  generateSchedule,
  openDatabase,
  upsertGuests,
  type VsDatabase,
} from '@vs/engine';
import { addDays, createLogger, systemActor } from '@vs/shared';
import { buildApp } from '../src/app';

/**
 * Spec acceptance test 11 (redaction): a booking with passports is created, its guests are
 * changed, it is amended and cancelled — through the real API with debug logging — and no
 * passport number may appear in the audit log, the captured logs, event payloads, webhook bodies,
 * stored idempotent responses or API responses.
 */
describe('test 11: passport numbers never leak', () => {
  const PASSPORTS = ['P11112222', 'Q33334444', 'R55556666', 'S77778888'];
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(chunk.toString());
      done();
    },
  });
  const ctx = { operatorId: '', actor: systemActor('test') };
  let api: VsDatabase;
  let backoffice: VsDatabase;
  let worker: VsDatabase;
  let app: ReturnType<typeof buildApp>;
  let token = '';
  let vesselId = '';
  let category = '';
  let start = '';
  const responses: string[] = [];

  beforeAll(async () => {
    api = openDatabase('vs_api', { config: testConfig(), max: 4 });
    backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 2 });
    worker = openDatabase('vs_worker', { config: testConfig(), max: 2 });
    ctx.operatorId = await createOperator('Redaction operator');
    const demo = await createDemoVessel(backoffice, ctx);
    vesselId = demo.vesselId;
    category = demo.categories.STD!;
    start = demo.validFrom;
    await generateSchedule(backoffice, ctx, { vesselId, until: addDays(demo.validFrom, 50) });
    const pricing = await createDemoPricing(backoffice, ctx, vesselId);
    const client = await createApiClient(backoffice, ctx, {
      channelId: pricing.channels.nilecrz,
      name: 'nilecrz',
    });
    await createWebhookEndpoint(backoffice, ctx, {
      channelId: pricing.channels.nilecrz,
      url: 'https://example.test/hooks',
    });
    app = buildApp({
      db: api,
      logger: createLogger('redaction-test', { level: 'debug', destination: sink }),
      tokenSecret: Buffer.alloc(32, 9),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      payload: {
        grant_type: 'client_credentials',
        client_id: client.clientId,
        client_secret: client.secret,
      },
    });
    token = res.json().access_token;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await api.close();
    await backoffice.close();
    await worker.close();
  });

  let n = 0;
  async function call(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': `redaction-${(n += 1)}` }),
        ...headers,
      },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    responses.push(res.body);
    return res;
  }
  async function sailing(pattern: string, offset: number) {
    const day = addDays(start as never, offset);
    const res = await call('GET', `/v1/sailings?vessel=${vesselId}&from=${day}&to=${day}`);
    return (res.json().sailings as { id: string; pattern_code: string }[]).find(
      (s) => s.pattern_code === pattern,
    )!.id;
  }

  it('create → guests → amend → cancel leaves no passport anywhere', async () => {
    const q = await call('POST', '/v1/quotes', {
      sailing_id: await sailing('LXR-7', 21),
      market: 'international',
      cabins: [{ category_id: category, adults: 2 }],
    });
    const hold = await call('POST', '/v1/holds', { quote_id: q.json().id, kind: 'checkout' });
    const confirmed = await call('POST', `/v1/holds/${hold.json().id}/confirm`, {
      guests: [
        {
          cabin: 0,
          first_name: 'Mona',
          last_name: 'Said',
          lead: true,
          passport_number: PASSPORTS[0],
        },
        { cabin: 0, first_name: 'Adel', last_name: 'Said', passport_number: PASSPORTS[1] },
      ],
    });
    expect(confirmed.statusCode).toBe(201);
    const ref = confirmed.json().ref as string;
    const bookingId = (
      await owner().query<{ id: string }>(
        `select id from vs.booking where ref = $1 and operator_id = $2`,
        [ref, ctx.operatorId],
      )
    ).rows[0]!.id;

    // A refused request that carries a passport (bad nationality) must not echo it anywhere.
    const refused = await call('PATCH', `/v1/bookings/${ref}/guests`, {
      guests: [
        {
          cabin: 0,
          first_name: 'Mona',
          last_name: 'Said',
          lead: true,
          nationality: 'egypt',
          passport_number: PASSPORTS[2],
        },
      ],
    });
    expect(refused.statusCode).toBe(400);
    const changed = await call('PATCH', `/v1/bookings/${ref}/guests`, {
      guests: [
        {
          cabin: 0,
          first_name: 'Mona',
          last_name: 'Said',
          lead: true,
          passport_number: PASSPORTS[2],
        },
        { cabin: 0, first_name: 'Adel', last_name: 'Said', passport_number: PASSPORTS[1] },
      ],
    });
    expect(changed.statusCode).toBe(200);
    // Staff edit through the back office too.
    await upsertGuests(backoffice, ctx, {
      bookingId,
      guests: [
        { cabin: 0, firstName: 'Mona', lastName: 'Said', lead: true, passportNumber: PASSPORTS[3] },
      ],
    });

    const quoteChange = await call('POST', `/v1/bookings/${ref}/amendment-quotes`, {
      sailing_id: await sailing('LXR-4', 21),
    });
    const amended = await call(
      'POST',
      `/v1/bookings/${ref}/amendments`,
      { amendment_quote_id: quoteChange.json().quote.id },
      { 'if-match': '"1"' },
    );
    expect(amended.statusCode).toBe(200);
    const cancelled = await call('POST', `/v1/bookings/${ref}/cancel`, {
      reason: 'Guest cancelled',
    });
    expect(cancelled.statusCode).toBe(200);

    // The webhook bodies the worker would send for all of this.
    const bodies: string[] = [];
    for (let i = 0; i < 20 && bodies.length === 0; i += 1) {
      await dispatchWebhooks(worker, ctx);
      for (const d of await claimDueDeliveries(worker, ctx, 200))
        bodies.push(JSON.stringify(eventJson(d.event)));
      if (bodies.length === 0) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(bodies.length).toBeGreaterThan(0);

    const stored = await owner().query<{ text: string }>(
      `select string_agg(t, E'\\n') as text from (
         select diff::text as t from vs.audit_log where operator_id = $1
         union all select payload::text from vs.event where operator_id = $1
         union all select coalesce(response_body::text, '') from vs.idempotency_key where operator_id = $1
         union all select coalesce(last_error, '') from vs.webhook_delivery where operator_id = $1
         union all select coalesce(error, '') from vs.document where operator_id = $1) x`,
      [ctx.operatorId],
    );
    const places = {
      audit_and_events_and_stored_responses: stored.rows[0]!.text,
      logs: logs.join(''),
      webhook_bodies: bodies.join('\n'),
      api_responses: responses.join('\n'),
    };
    expect(places.logs.length).toBeGreaterThan(0);
    for (const [place, text] of Object.entries(places)) {
      for (const passport of PASSPORTS)
        expect(text, `${passport} in ${place}`).not.toContain(passport);
    }
    // The numbers are stored — encrypted — for the manifest.
    const encrypted = await owner().query(
      `select count(*)::int as n from vs.guest where booking_id = $1 and passport_ciphertext is not null`,
      [bookingId],
    );
    expect(encrypted.rows[0].n).toBe(1);
  }, 60_000);
});
