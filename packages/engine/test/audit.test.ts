import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOperator, owner, testConfig } from '@vs/db/testing';
import { uuidv7, type Actor } from '@vs/shared';
import { audit, buildDiff, openDatabase, type VsDatabase } from '../src/index';

describe('buildDiff', () => {
  it('records changed fields only, and only "changed" for sensitive ones', () => {
    const diff = buildDiff(
      {
        status: 'held',
        passport_number: 'A1234567',
        total: 1000n,
        note: 'x',
        updated_at: new Date(0),
      },
      {
        status: 'confirmed',
        passport_number: 'B7654321',
        total: 1000n,
        note: 'x',
        updated_at: new Date(),
      },
    );
    expect(diff).toEqual({
      status: { from: 'held', to: 'confirmed' },
      passport_number: { changed: true },
    });
  });

  it('redacts sensitive keys nested inside changed values', () => {
    const diff = buildDiff({ guests: [] }, { guests: [{ name: 'A', passportNumber: 'P1' }] });
    expect(JSON.stringify(diff)).not.toContain('P1');
  });
});

describe('audit()', () => {
  let db: VsDatabase;
  let operatorId: string;

  beforeAll(async () => {
    db = openDatabase('vs_api', { config: testConfig(), max: 2 });
    operatorId = await createOperator('Audit operator');
  });

  afterAll(async () => {
    await db.close();
  });

  it('writes actor, action, entity and a redacted diff in the caller transaction', async () => {
    const actor: Actor = { type: 'channel', id: uuidv7(), label: 'nilecrz' };
    const entityId = uuidv7();
    await db.withTenantTx(operatorId, actor, ({ db: tx }) =>
      audit(tx, operatorId, actor, {
        action: 'guest.updated',
        entity: 'guest',
        entityId,
        before: { name: 'A', passport_number: null },
        after: { name: 'B', passport_number: 'Z9988776' },
        requestKey: 'key-1',
      }),
    );
    const { rows } = await owner().query('select * from vs.audit_log where entity_id = $1', [
      entityId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: 'channel',
      actor_id: actor.id,
      actor_label: 'nilecrz',
      action: 'guest.updated',
      entity: 'guest',
      request_key: 'key-1',
      diff: { name: { from: 'A', to: 'B' }, passport_number: { changed: true } },
    });
    expect(JSON.stringify(rows[0])).not.toContain('Z9988776');
  });

  it('is append-only for runtime roles', async () => {
    const actor: Actor = { type: 'system', label: 'test' };
    await expect(
      db.withTenantTx(operatorId, actor, ({ db: tx }) => tx.deleteFrom('audit_log').execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
