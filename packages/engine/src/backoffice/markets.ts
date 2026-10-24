import { sql } from 'kysely';
import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { pgErrorCode } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext, type Tx } from '../internal';

/**
 * Markets: who a price is for (International, Egyptian resident, GCC…). Each company keeps its
 * own list; rate plans and quotes name a market by its code. `needsResidencyProof` puts the
 * "bring proof of residency or ID" line on vouchers.
 */

export interface Market {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  needsResidencyProof: boolean;
  active: boolean;
  sortOrder: number;
  plans: number;
}

export async function listMarkets(db: VsDatabase, ctx: EngineContext): Promise<Market[]> {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const { rows } = await sql<Market>`
      select m.id, m.code, m.name_en as "nameEn", m.name_ar as "nameAr",
             m.needs_residency_proof as "needsResidencyProof", m.active, m.sort_order as "sortOrder",
             (select count(*)::int from vs.rate_plan r where r.market = m.code) as plans
      from vs.market m order by m.active desc, m.sort_order, m.code`.execute(tx);
    return rows;
  });
}

/** A rate plan may only name a market the company has and offers. */
export async function assertMarket(tx: Tx, code: string) {
  const market = await tx
    .selectFrom('market')
    .select(['active'])
    .where('code', '=', code)
    .executeTakeFirst();
  if (!market?.active)
    throw new DomainError('VALIDATION_FAILED', {
      message: 'Unknown market',
      details: { reason: 'unknown_market' },
    });
}

const fields = {
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  needsResidencyProof: z.boolean(),
  sortOrder: z.number().int().min(0).max(999).default(100),
};

export const addMarketInput = z.object({
  /** Lower case, e.g. gcc or european: used by rate plans, quotes and the Channel API. */
  code: z.string().regex(/^[a-z][a-z_]{1,31}$/),
  ...fields,
});

export async function addMarket(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof addMarketInput>,
) {
  const data = parseInput(addMarketInput, input);
  try {
    return await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
      const market = await tx
        .insertInto('market')
        .values({
          operator_id: ctx.operatorId,
          code: data.code,
          name_en: data.nameEn,
          name_ar: data.nameAr,
          needs_residency_proof: data.needsResidencyProof,
          sort_order: data.sortOrder,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(tx, ctx.operatorId, ctx.actor, {
        action: 'market.created',
        entity: 'market',
        entityId: market.id,
        after: market,
      });
      return market;
    });
  } catch (error) {
    if (pgErrorCode(error) === '23505')
      throw new DomainError('VALIDATION_FAILED', {
        message: 'Already used',
        details: { reason: 'code_taken' },
      });
    throw error;
  }
}

export const updateMarketInput = z.object({
  marketId: z.uuid(),
  ...fields,
  /** Off: no new rate plans in this market; existing plans keep selling. */
  active: z.boolean(),
});

/** Everything but the code, which rate plans, quotes and channels already use. */
export async function updateMarket(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateMarketInput>,
) {
  const data = parseInput(updateMarketInput, input);
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('market')
      .selectAll()
      .where('id', '=', data.marketId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Market not found' });
    const after = await tx
      .updateTable('market')
      .set({
        name_en: data.nameEn,
        name_ar: data.nameAr,
        needs_residency_proof: data.needsResidencyProof,
        sort_order: data.sortOrder,
        active: data.active,
      })
      .where('id', '=', data.marketId)
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'market.updated',
      entity: 'market',
      entityId: data.marketId,
      before: {
        name_en: before.name_en,
        needs_residency_proof: before.needs_residency_proof,
        active: before.active,
      },
      after: {
        name_en: after.name_en,
        needs_residency_proof: after.needs_residency_proof,
        active: after.active,
      },
    });
    return after;
  });
}

/** A market no rate plan, quote or booking has used: one added by mistake. */
export async function deleteMarket(db: VsDatabase, ctx: EngineContext, marketId: string) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx
      .selectFrom('market')
      .selectAll()
      .where('id', '=', marketId)
      .forUpdate()
      .executeTakeFirst();
    if (!before) throw new DomainError('NOT_FOUND', { message: 'Market not found' });
    const { rows } = await sql<{ n: number }>`
      select (select count(*)::int from vs.rate_plan where market = ${before.code})
           + (select count(*)::int from vs.quote where market = ${before.code})
           + (select count(*)::int from vs.booking where market = ${before.code}) as n`.execute(tx);
    if (rows[0]!.n > 0)
      throw new DomainError('INVALID_STATE', {
        message: 'The market is in use',
        details: { reason: 'market_in_use' },
      });
    await tx.deleteFrom('market').where('id', '=', marketId).execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'market.deleted',
      entity: 'market',
      entityId: marketId,
      before: { code: before.code, name_en: before.name_en },
    });
  });
}
