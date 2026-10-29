import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig, required } from '@vs/shared';

// Empties a company at the owner's request: every row of every company table goes (vessels,
// schedule, prices, channels and contracts, bookings, invoices, receipts, folios, documents,
// settings, the audit log), except the company itself, its settings row, its staff logins and
// invitations, and its back-office channel, so the owner can still sign in and start again.
// Rows are deleted children first, in one transaction; the tables that refuse deletes from the
// app (issued invoices, receipts, the audit log) are opened only inside it, as their owner.
// Invoice and booking numbering start again (booking numbers only when no company has any).
//   pnpm --filter @vs/engine wipe-company --slug <slug>            counts only, changes nothing
//   pnpm --filter @vs/engine wipe-company --slug <slug> --delete   deletes
// Hosted: add --confirm-hosted as well.
const { values } = parseArgs({
  options: {
    slug: { type: 'string' },
    delete: { type: 'boolean' },
    'confirm-hosted': { type: 'boolean' },
  },
});
const config = loadConfig();
if (!values.slug) throw new Error('usage: wipe-company --slug <company slug> [--delete]');
if (config.VS_ENV === 'hosted' && !values['confirm-hosted']) {
  console.error('This empties a company on the hosted database: add --confirm-hosted');
  process.exit(1);
}
const client = new pg.Client({
  connectionString: required(config, 'DATABASE_URL_ADMIN'),
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});
await client.connect();
/** What stays, per table: a condition on the rows to keep. */
const KEEP: Record<string, string> = {
  operator_setting: 'true',
  staff_user: 'true',
  staff_invitation: 'true',
  channel: `type = 'back_office'`,
};
try {
  await client.query('begin');
  await client.query('set local role vs_owner');
  const company = (
    await client.query<{ id: string; name: string }>(
      `select id, name from vs.operator where slug = $1`,
      [values.slug],
    )
  ).rows[0];
  if (!company) throw new Error(`No company with slug ${values.slug}`);
  const tables = (
    await client.query<{ name: string }>(`
      select c.table_name as name from information_schema.columns c
      join information_schema.tables t using (table_schema, table_name)
      where c.table_schema = 'vs' and c.column_name = 'operator_id' and t.table_type = 'BASE TABLE'`)
  ).rows.map((r) => r.name);
  // Foreign keys between company tables: a table is emptied after every table pointing at it.
  const edges = (
    await client.query<{ child: string; parent: string; columns: string[]; nullable: boolean }>(`
      select cl.relname as child, pl.relname as parent,
             array_agg(a.attname order by a.attnum) as columns, bool_and(not a.attnotnull) as nullable
      from pg_constraint k
      join pg_class cl on cl.oid = k.conrelid join pg_namespace cn on cn.oid = cl.relnamespace
      join pg_class pl on pl.oid = k.confrelid join pg_namespace pn on pn.oid = pl.relnamespace
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey)
      where k.contype = 'f' and cn.nspname = 'vs' and pn.nspname = 'vs' and cl.relname <> pl.relname
        and a.attname <> 'operator_id'
      group by k.oid, cl.relname, pl.relname`)
  ).rows.filter((e) => tables.includes(e.child) && tables.includes(e.parent));
  const order: string[] = [];
  const left = new Set(tables);
  const broken: typeof edges = [];
  while (left.size) {
    const ready = [...left].filter((t) =>
      edges.every(
        (e) => e.parent !== t || !left.has(e.child) || e.child === t || broken.includes(e),
      ),
    );
    if (ready.length === 0) {
      // A cycle: clear one nullable link inside it first, then carry on.
      const cut = edges.find(
        (e) => left.has(e.child) && left.has(e.parent) && e.nullable && !broken.includes(e),
      );
      if (!cut) throw new Error(`No way to order ${[...left].join(', ')}`);
      broken.push(cut);
      continue;
    }
    for (const t of ready) {
      order.push(t);
      left.delete(t);
    }
  }
  const where = (t: string) => `operator_id = $1${KEEP[t] ? ` and not (${KEEP[t]})` : ''}`;
  for (const cut of broken)
    await client.query(
      `update vs.${cut.child} set ${cut.columns.map((c) => `${c} = null`).join(', ')} where ${where(cut.child)}`,
      [company.id],
    );
  let total = 0;
  for (const t of order) {
    await client.query(`alter table vs.${t} disable trigger user`);
    const { rowCount } = await client.query(`delete from vs.${t} where ${where(t)}`, [company.id]);
    await client.query(`alter table vs.${t} enable trigger user`);
    if (rowCount) console.log(`${t}: ${rowCount}`);
    total += rowCount ?? 0;
  }
  const bookingsLeft = (await client.query(`select count(*)::int as n from vs.booking`)).rows[0].n;
  if (bookingsLeft === 0) await client.query(`select setval('vs.booking_ref_seq', 1, false)`);
  const kept = await client.query<{ staff: number; channels: number }>(
    `select (select count(*)::int from vs.staff_user where operator_id = $1) as staff,
            (select count(*)::int from vs.channel where operator_id = $1) as channels`,
    [company.id],
  );
  console.log(
    `${company.name}: ${total} rows ${values.delete ? 'deleted' : 'would be deleted'}; kept the company, ` +
      `${kept.rows[0]!.staff} staff login(s), ${kept.rows[0]!.channels} back-office channel` +
      (bookingsLeft === 0 ? '; booking numbers start again at 00001' : ''),
  );
  await client.query(values.delete ? 'commit' : 'rollback');
  if (!values.delete) console.log('Nothing changed (counts only). Add --delete to delete.');
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  await client.end();
}
