import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDomainError } from '@vs/contracts';
import { openDatabase } from '@vs/db';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { systemActor } from '@vs/shared';
import { documentBrand, getBranding, setLogo, updateBranding } from '../src/index';
import type { EngineContext } from '../src/internal';

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

// The smallest valid PNG header and a JPEG start-of-image marker; the content is not decoded.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

describe('branding', () => {
  const db = openDatabase('vs_backoffice', { config: testConfig(), max: 4 });
  let ctx: EngineContext;

  beforeAll(async () => {
    ctx = { operatorId: await createOperator('Branding Co'), actor: systemActor('test') };
  });

  afterAll(async () => {
    await db.close();
  });

  it('uses the defaults until a company sets its own', async () => {
    expect(await getBranding(db, ctx)).toMatchObject({
      primaryColor: '#165a5c',
      secondaryColor: '#c58b3c',
      logo: null,
    });
    expect(await documentBrand(db, ctx)).toMatchObject({ name: 'Branding Co', logo: null });
  });

  it('normalises colours, clears empty fields and audits what changed', async () => {
    const after = await updateBranding(db, ctx, {
      primaryColor: ' #7A1E3A ',
      secondaryColor: 'fc0',
      phone: '+20 95 123 4567',
      email: 'Res@Example.test',
      website: '',
    });
    expect(after).toMatchObject({
      primaryColor: '#7a1e3a',
      secondaryColor: '#ffcc00',
      phone: '+20 95 123 4567',
      email: 'res@example.test',
      website: null,
    });
    const { rows } = await owner().query<{ diff: Record<string, unknown> }>(
      `select diff from vs.audit_log where operator_id = $1 and action = 'branding.updated'`,
      [ctx.operatorId],
    );
    expect(rows[0]!.diff).toMatchObject({ primaryColor: { from: '#165a5c', to: '#7a1e3a' } });
  });

  it('refuses a colour that is not one', async () => {
    expect(await codeOf(updateBranding(db, ctx, { primaryColor: 'teal' }))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('takes a PNG or JPEG logo by its content, up to 200 KB, and removes it', async () => {
    const png = await setLogo(db, ctx, { base64: PNG.toString('base64') });
    expect(png.logo).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
    const jpeg = await setLogo(db, ctx, { base64: JPEG.toString('base64') });
    expect(jpeg.logo?.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect((await documentBrand(db, ctx)).logo).toBe(jpeg.logo);

    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    expect(await codeOf(setLogo(db, ctx, { base64: svg.toString('base64') }))).toBe(
      'VALIDATION_FAILED',
    );
    const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024)]);
    expect(await codeOf(setLogo(db, ctx, { base64: big.toString('base64') }))).toBe(
      'VALIDATION_FAILED',
    );

    expect((await setLogo(db, ctx, { base64: '' })).logo).toBeNull();
    const { rows } = await owner().query<{ action: string }>(
      `select action from vs.audit_log where operator_id = $1 and action like 'branding.logo%' order by created_at`,
      [ctx.operatorId],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'branding.logo_set',
      'branding.logo_set',
      'branding.logo_removed',
    ]);
  });
});
