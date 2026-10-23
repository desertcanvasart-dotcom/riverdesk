import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import {
  cancelBooking,
  confirmHold,
  createDemoPricing,
  createDemoVessel,
  createHold,
  createQuote,
  createWebhookEndpoint,
  generateSchedule,
  openDatabase,
  replayWebhookDelivery,
  verifyWebhookSignature,
  type VsDatabase,
} from '@vs/engine';
import { addDays, systemActor } from '@vs/shared';
import { runWebhooks } from '../src/tasks/webhook-jobs';

interface Received {
  status: number;
  signatureOk: boolean;
  event: {
    event_id: string;
    type: string;
    resource_id: string;
    resource_version: number;
    data: Record<string, unknown>;
  };
}

describe('webhooks', () => {
  let db: VsDatabase;
  let server: Server;
  let url: string;
  let secret: string;
  let channelId: string;
  const received: Received[] = [];
  /** Answer 500 to these event ids (simulates a receiver outage). */
  const failing = new Set<string>();
  const ctx = { operatorId: '', actor: systemActor('test') };
  let book: () => Promise<string>;

  beforeAll(async () => {
    db = openDatabase('vs_worker', { config: testConfig(), max: 4 });
    const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 2 });
    ctx.operatorId = await createOperator('Webhook operator');
    const demo = await createDemoVessel(backoffice, ctx);
    await generateSchedule(backoffice, ctx, {
      vesselId: demo.vesselId,
      until: addDays(demo.validFrom, 20),
    });
    const pricing = await createDemoPricing(backoffice, ctx, demo.vesselId);
    channelId = pricing.channels.nilecrz;

    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const event = JSON.parse(body);
        const signatureOk = verifyWebhookSignature(
          secret,
          body,
          String(req.headers['x-vs-signature']),
          Math.floor(Date.now() / 1000),
        );
        const status = failing.has(event.event_id) ? 500 : 200;
        received.push({ status, signatureOk, event });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;
    ({ secret } = await createWebhookEndpoint(backoffice, ctx, { channelId, url }));

    const sailing = (
      await owner().query<{ id: string }>(
        `select s.id from vs.sailing s join vs.sailing_pattern sp on sp.id = s.pattern_id where s.vessel_id = $1 and sp.code = 'LXR-4' order by s.embark_date limit 1`,
        [demo.vesselId],
      )
    ).rows[0]!.id;
    book = async () => {
      const quote = await createQuote(backoffice, ctx, {
        channelId,
        sailingId: sailing,
        market: 'international',
        cabins: [{ categoryId: demo.categories.STD, adults: 2 }],
      });
      const hold = await createHold(backoffice, ctx, {
        channelId,
        quoteId: quote.id,
        kind: 'option',
      });
      const booking = await confirmHold(backoffice, ctx, {
        holdId: hold.holdId,
        guests: [
          { cabin: 0, firstName: 'A', lastName: 'B', lead: true, passportNumber: 'X99887766' },
        ],
      });
      return booking.bookingId;
    };
    afterAllClose.push(() => backoffice.close());
  }, 120_000);

  const afterAllClose: (() => Promise<void>)[] = [];

  /**
   * Runs the job until `done` holds (5 s at most). Events are only dispatched once they are below
   * the feed's safe horizon, and any transaction open elsewhere in the cluster (other test files
   * run in parallel) holds the horizon back for a moment: the job is right to wait.
   */
  async function runUntil(done: () => boolean) {
    const totals = { created: 0, sent: 0, failed: 0 };
    for (const deadline = Date.now() + 5_000; ;) {
      const result = await runWebhooks(db, ctx);
      totals.created += result.created;
      totals.sent += result.sent;
      totals.failed += result.failed;
      if (done() || Date.now() > deadline) return totals;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  afterAll(async () => {
    for (const close of afterAllClose) await close();
    await new Promise((done) => server.close(done));
    await db.close();
  });

  it('delivers signed events; payloads never contain passport numbers', async () => {
    const bookingId = await book();
    const result = await runUntil(() =>
      received.some(
        (r) => r.event.type === 'booking.confirmed' && r.event.resource_id === bookingId,
      ),
    );
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const confirmed = received.find(
      (r) => r.event.type === 'booking.confirmed' && r.event.resource_id === bookingId,
    );
    expect(confirmed).toMatchObject({ status: 200, signatureOk: true });
    expect(received.every((r) => r.signatureOk)).toBe(true);
    expect(JSON.stringify(received)).not.toContain('X99887766');
    const attempts = await owner().query(
      `select count(*)::int as n from vs.webhook_attempt where operator_id = $1`,
      [ctx.operatorId],
    );
    expect(attempts.rows[0].n).toBe(received.length);
    expect(
      verifyWebhookSignature(
        secret,
        '{"tampered":true}',
        't=1,v1=00',
        Math.floor(Date.now() / 1000),
      ),
    ).toBe(false);
  });

  it('keeps each resource in order: a later event waits until the earlier one is delivered', async () => {
    const bookingId = await book();
    const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 1 });
    await cancelBooking(backoffice, ctx, { bookingId, reason: 'test' });
    await backoffice.close();
    // Two events for this booking: confirmed (v2), then cancelled (v3). The first fails at the
    // receiver; the second must not overtake it.
    const { rows } = await owner().query<{ id: string; type: string }>(
      `select id, type from vs.event where resource_id = $1 order by seq`,
      [bookingId],
    );
    expect(rows.map((r) => r.type)).toEqual(['booking.confirmed', 'booking.cancelled']);
    failing.add(rows[0]!.id);
    const before = received.length;
    await runUntil(() => received.slice(before).some((r) => r.event.resource_id === bookingId));
    const forBooking = received.slice(before).filter((r) => r.event.resource_id === bookingId);
    expect(forBooking.map((r) => [r.event.type, r.status])).toEqual([['booking.confirmed', 500]]);

    // The receiver recovers; after the backoff the first event is delivered, then the rest.
    failing.clear();
    await owner().query(
      `update vs.webhook_delivery set next_attempt_at = now() where resource_id = $1`,
      [bookingId],
    );
    const mark = received.length;
    await runUntil(
      () => received.slice(mark).filter((r) => r.event.resource_id === bookingId).length >= 2,
    );
    const delivered = received.slice(mark).filter((r) => r.event.resource_id === bookingId);
    expect(delivered.map((r) => [r.event.type, r.status])).toEqual([
      ['booking.confirmed', 200],
      ['booking.cancelled', 200],
    ]);
    const versions = delivered.map((r) => r.event.resource_version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(
      received.slice(mark).some((r) => r.event.event_id === rows[0]!.id && r.status === 200),
    ).toBe(true);
  });

  it('a replayed delivery arrives again; a receiver keyed on resource_version ignores the duplicate', async () => {
    const delivered = await owner().query<{ id: string; event_id: string }>(
      `select d.id, d.event_id from vs.webhook_delivery d where d.operator_id = $1 and d.status = 'delivered' limit 1`,
      [ctx.operatorId],
    );
    const backoffice = openDatabase('vs_backoffice', { config: testConfig(), max: 1 });
    await replayWebhookDelivery(backoffice, ctx, { deliveryId: delivered.rows[0]!.id });
    await backoffice.close();
    await runWebhooks(db, ctx);
    const copies = received.filter(
      (r) => r.event.event_id === delivered.rows[0]!.event_id && r.status === 200,
    );
    expect(copies.length).toBeGreaterThanOrEqual(2);

    // What the integration guide asks receivers to do: apply a version only if it is newer.
    const seen = new Map<string, number>();
    let applied = 0;
    for (const r of received.filter((x) => x.status === 200)) {
      const last = seen.get(r.event.resource_id) ?? 0;
      if (r.event.resource_version > last) {
        seen.set(r.event.resource_id, r.event.resource_version);
        applied += 1;
      }
    }
    const distinct = new Set(
      received
        .filter((x) => x.status === 200)
        .map((r) => `${r.event.resource_id}:${r.event.resource_version}`),
    ).size;
    expect(applied).toBeLessThanOrEqual(distinct);
  });
});
