import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { owner, roleClient } from '../src/testing/index';

const request = (over: Record<string, unknown> = {}) => ({
  full_name: 'Test Owner',
  company_name: 'Test Cruises',
  vessel_names: 'MS Test',
  vessel_count: '1',
  vessel_type: 'cruise',
  whatsapp: '+201001234567',
  email: 'Owner@Example.com',
  home_port: 'luxor',
  current_tool: 'excel',
  message: '',
  locale: 'ar',
  consent: true,
  ...over,
});

/** A fresh client hash per test, so the rate limit of one test does not leak into another. */
const hash = () =>
  Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

describe('pilot requests (website role)', () => {
  let website: pg.Client;

  beforeAll(async () => {
    website = await roleClient('vs_website');
  });

  afterAll(async () => {
    await website.end();
  });

  async function submit(body: Record<string, unknown>, clientHash: string) {
    const { rows } = await website.query<{ id: string }>(
      'select vs.submit_pilot_request($1::jsonb, $2) as id',
      [JSON.stringify(body), clientHash],
    );
    return rows[0]!.id;
  }

  it('stores a request, normalising the email and dropping an empty message', async () => {
    const id = await submit(request(), hash());
    const { rows } = await owner().query(
      'select email, message, consent_at is not null as consented from platform.pilot_request where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ email: 'owner@example.com', message: null, consented: true });
  });

  it('refuses a request without consent or with a malformed WhatsApp number', async () => {
    await expect(submit(request({ consent: false }), hash())).rejects.toThrow(/consent/);
    await expect(submit(request({ whatsapp: '01001234567' }), hash())).rejects.toThrow(
      /check constraint/,
    );
  });

  it('allows three requests per client an hour, then refuses', async () => {
    const client = hash();
    for (let i = 0; i < 3; i++) await submit(request(), client);
    await expect(submit(request(), client)).rejects.toThrow('rate_limited');
    // Another client is not affected.
    await expect(submit(request(), hash())).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cannot read pilot requests or any company data', async () => {
    for (const statement of [
      'select count(*) from platform.pilot_request',
      'select count(*) from vs.operator',
      'select count(*) from vs.booking',
    ]) {
      await expect(website.query(statement)).rejects.toThrow(/permission denied/);
    }
  });

  it('cannot call the other SECURITY DEFINER functions', async () => {
    await expect(website.query(`select vs.platform_is_admin('a@b.co')`)).rejects.toThrow(
      /permission denied/,
    );
  });
});
