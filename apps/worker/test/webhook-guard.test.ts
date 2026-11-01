import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DueDelivery } from '@vs/engine';
import { publicLookup, sendWebhook } from '../src/tasks/webhook-jobs';

const delivery = (url: string): DueDelivery => ({
  deliveryId: '00000000-0000-0000-0000-000000000001',
  attempt: 1,
  url,
  secret: 'whsec_test',
  event: {
    eventId: '00000000-0000-0000-0000-000000000002',
    type: 'booking.confirmed',
    resource: 'booking',
    resourceId: '00000000-0000-0000-0000-000000000003',
    resourceVersion: 1n,
    occurredAt: new Date(),
    data: {},
    txid: '1',
    seq: 1n,
  },
});

describe('webhook sending guards', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/moved') res.writeHead(302, { location: '/target' }).end();
      else res.writeHead(200).end();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  it('never follows a redirect: a 3xx is a failed attempt', async () => {
    const result = await sendWebhook(delivery(`${base}/moved`), { hosted: false });
    expect(result).toMatchObject({ statusCode: 302 });
    expect(result.error).toMatch(/redirects are not followed/);
    expect(hits).toEqual(['/moved']);
  });

  it('hosted: refuses plain http and private addresses before sending anything', async () => {
    hits.length = 0;
    expect((await sendWebhook(delivery(`${base}/hooks`), { hosted: true })).error).toMatch(/https/);
    const port = (server.address() as AddressInfo).port;
    expect(
      (await sendWebhook(delivery(`https://127.0.0.1:${port}/hooks`), { hosted: true })).error,
    ).toMatch(/public address/);
    expect(hits).toEqual([]);
  });

  it('hosted: a name that resolves inside is refused at connect time', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((done) =>
      publicLookup('localhost', {}, (err) => done(err)),
    );
    expect(error?.code).toBe('EPRIVATEADDR');
  });
});
