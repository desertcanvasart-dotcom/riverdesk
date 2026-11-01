import { describe, expect, it } from 'vitest';
import { loadConfig, roleConnection } from '../src/config';

describe('config', () => {
  const base = { VS_API_PASSWORD: 'api-password', VS_WORKER_PASSWORD: 'worker-password' };

  it('applies defaults and treats empty values as unset', () => {
    const config = loadConfig({ ...base, DATABASE_SESSION_PORT: '' });
    expect(config.DATABASE_PORT).toBe(55322);
    expect(config.DATABASE_SESSION_PORT).toBeUndefined();
    expect(config.DATABASE_SSL).toBe(false);
  });

  it('rejects invalid values with a readable message', () => {
    expect(() => loadConfig({ DATABASE_PORT: 'abc' })).toThrow(/DATABASE_PORT/);
    expect(() => loadConfig({ PASSPORT_KEY: 'c2hvcnQ=' })).toThrow(/PASSPORT_KEY/);
  });

  it('uses role.projectref user names on the Supabase pooler', () => {
    const config = loadConfig({
      ...base,
      DATABASE_HOST: 'aws-0-eu-west-1.pooler.supabase.com',
      DATABASE_PORT: '6543',
      DATABASE_SESSION_PORT: '5432',
      SUPABASE_PROJECT_REF: 'abcdefghijklmnopqrst',
      DATABASE_SSL: 'true',
    });
    expect(roleConnection(config, 'vs_api')).toMatchObject({
      user: 'vs_api.abcdefghijklmnopqrst',
      port: 6543,
      ssl: true,
    });
    expect(roleConnection(config, 'vs_worker', { session: true }).port).toBe(5432);
  });

  it('uses plain role names locally', () => {
    expect(roleConnection(loadConfig(base), 'vs_api').user).toBe('vs_api');
  });

  it('hosted: refuses the example secrets from .env.example, which are fine locally', () => {
    const example = {
      ...base,
      PASSPORT_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      API_TOKEN_SECRET: 'bG9jYWwtb25seS10b2tlbi1zZWNyZXQtbm90LWZvci1wcm9kdWN0aW9uIQ==',
    };
    expect(() => loadConfig(example)).not.toThrow();
    expect(() => loadConfig({ ...example, VS_ENV: 'hosted' })).toThrow(
      /PASSPORT_KEY[\s\S]*API_TOKEN_SECRET/,
    );
    const real = {
      ...base,
      VS_ENV: 'hosted',
      PASSPORT_KEY: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1)).toString('base64'),
      API_TOKEN_SECRET: Buffer.from(Array.from({ length: 32 }, (_, i) => i * 5 + 3)).toString(
        'base64',
      ),
    };
    expect(() => loadConfig(real)).not.toThrow();
    // One repeated byte is no key, whatever it is.
    expect(() =>
      loadConfig({ ...real, PASSPORT_KEY: Buffer.alloc(32, 9).toString('base64') }),
    ).toThrow(/PASSPORT_KEY/);
  });
});
