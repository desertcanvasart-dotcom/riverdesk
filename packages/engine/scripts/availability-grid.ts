import { addDays, loadConfig, systemActor } from '@vs/shared';
import { DEMO_OPERATOR_ID, getAvailability, openDatabase, todayInCairo } from '../src/index';

// Prints the demo vessel's availability for the next 4 weeks as a Markdown table.
const weeks = Number(process.argv[2] ?? 4);

const db = openDatabase('vs_backoffice', { config: loadConfig() });
const ctx = { operatorId: DEMO_OPERATOR_ID, actor: systemActor('report') };
try {
  const vessel = await db.withTenantTx(ctx.operatorId, ctx.actor, ({ db: tx }) =>
    tx
      .selectFrom('vessel')
      .select(['id', 'name'])
      .where('code', '=', 'NILEDEMO')
      .executeTakeFirstOrThrow(),
  );
  const from = await todayInCairo(db);
  const to = addDays(from, weeks * 7 - 1);
  const { asOf, sailings } = await getAvailability(db, ctx, { vesselId: vessel.id, from, to });
  const codes = sailings[0]?.categories.map((c) => c.code) ?? [];
  console.log(
    `${vessel.name} — free cabins per sailing, ${from} to ${to} (as of ${asOf.toISOString()})\n`,
  );
  console.log(`| Embark | Cruise | Route | ${codes.join(' | ')} |`);
  console.log(`| --- | --- | --- | ${codes.map(() => '---:').join(' | ')} |`);
  for (const s of sailings) {
    const route = `${s.embarkPort} → ${s.disembarkPort}`;
    const free = s.categories.map((c) => (c.stopSale ? `${c.free} (stop)` : String(c.free)));
    console.log(
      `| ${s.embarkDate} | ${s.patternCode} (${s.nights} n) | ${route} | ${free.join(' | ')} |`,
    );
  }
} finally {
  await db.close();
}
