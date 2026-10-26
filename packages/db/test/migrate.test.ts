import { describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate';
import { testConfig } from '../src/testing/index';

describe('migration runner', () => {
  it('is idempotent: a second run applies nothing', async () => {
    const config = testConfig();
    const applied = await migrate({
      adminUrl: config.DATABASE_URL_ADMIN!,
      passwords: {
        vs_backoffice: config.VS_BACKOFFICE_PASSWORD!,
        vs_api: config.VS_API_PASSWORD!,
        vs_worker: config.VS_WORKER_PASSWORD!,
        vs_website: config.VS_WEBSITE_PASSWORD!,
      },
    });
    expect(applied).toEqual([]);
  });
});
