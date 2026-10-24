import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { createHold, healthAlerts } from '../src/index';
import { bookingWorld, expireNow, type BookingWorld } from './helpers/booking-world';

describe('health alerts', () => {
  let w: BookingWorld;

  beforeAll(async () => {
    w = await bookingWorld();
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('is quiet on a healthy company', async () => {
    expect(await healthAlerts(w.db, w.ctx)).toEqual([]);
  });

  it('reports a hold-expiry backlog, a webhook failure rate and new payment exceptions', async () => {
    const hold = await createHold(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      quoteId: await w.quote(w.channels.nilecrz, await w.sailing('LXR-4', 14), [{ cat: 'STD' }]),
      kind: 'option',
    });
    await expireNow('hold', hold.holdId);
    await owner().query(
      `update vs.hold set expires_at = now() - interval '10 minutes' where id = $1`,
      [hold.holdId],
    );

    const endpoint = await owner().query<{ id: string }>(
      `insert into vs.webhook_endpoint (operator_id, channel_id, url, secret_ciphertext, secret_key_id)
       values ($1, $2, 'https://example.test/h', '\\x00', 'k') returning id`,
      [w.ctx.operatorId, w.channels.nilecrz],
    );
    const event = await owner().query<{
      id: string;
      resource_id: string;
      txid: string;
      seq: string;
    }>(
      `select id, resource_id, txid::text, seq::text from vs.event where operator_id = $1 limit 1`,
      [w.ctx.operatorId],
    );
    const e = event.rows[0]!;
    const delivery = await owner().query<{ id: string }>(
      `insert into vs.webhook_delivery (operator_id, endpoint_id, event_id, resource_id, event_txid, event_seq)
       values ($1, $2, $3, $4, $5::xid8, $6) returning id`,
      [w.ctx.operatorId, endpoint.rows[0]!.id, e.id, e.resource_id, e.txid, e.seq],
    );
    for (let i = 1; i <= 10; i += 1) {
      await owner().query(
        `insert into vs.webhook_attempt (operator_id, delivery_id, attempt, status_code) values ($1, $2, $3, $4)`,
        [w.ctx.operatorId, delivery.rows[0]!.id, i, i <= 2 ? 500 : 200],
      );
    }
    await owner().query(
      `insert into vs.exception (operator_id, kind, severity, summary) values ($1, 'late_payment', 'warning', 'test')`,
      [w.ctx.operatorId],
    );

    const alerts = await healthAlerts(w.db, w.ctx);
    expect(alerts.map((a) => a.name).sort()).toEqual([
      'hold_expiry_backlog',
      'payment_exceptions',
      'webhook_failure_rate',
    ]);
    expect(alerts.find((a) => a.name === 'webhook_failure_rate')!.detail).toMatchObject({
      attempts: 10,
      rate: 0.2,
    });
    // Leave the company clean for the invariant check after this file.
    await owner().query(`update vs.hold set expires_at = now() + interval '1 hour' where id = $1`, [
      hold.holdId,
    ]);
  });
});
