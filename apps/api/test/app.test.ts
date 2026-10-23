import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '@vs/db/testing';
import { DomainError } from '@vs/contracts';
import { openDatabase, type VsDatabase } from '@vs/engine';
import { createLogger } from '@vs/shared';
import { buildApp } from '../src/app';

describe('api', () => {
  let db: VsDatabase;
  const logger = createLogger('api-test', { level: 'silent' });

  beforeAll(() => {
    db = openDatabase('vs_api', { config: testConfig(), max: 1 });
  });

  afterAll(async () => {
    await db.close();
  });

  it('reports health with a database round trip as vs_api', async () => {
    const app = buildApp({ db, logger });
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', database: true });
  });

  it('maps domain errors to their HTTP status and hides unknown errors', async () => {
    const app = buildApp({ db, logger });
    app.get('/boom/domain', async () => {
      throw new DomainError('RETRY_LATER');
    });
    app.get('/boom/bug', async () => {
      throw new Error('secret internals');
    });
    const domain = await app.inject({ method: 'GET', url: '/boom/domain' });
    expect(domain.statusCode).toBe(409);
    expect(domain.headers['retry-after']).toBe('1');
    expect(domain.json()).toEqual({ error: { code: 'RETRY_LATER', message: 'Busy; retry later' } });
    const bug = await app.inject({ method: 'GET', url: '/boom/bug' });
    expect(bug.statusCode).toBe(500);
    expect(bug.body).not.toContain('secret internals');
  });
});
