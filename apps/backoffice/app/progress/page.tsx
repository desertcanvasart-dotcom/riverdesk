import { notFound } from 'next/navigation';
import { DEMO_OPERATOR_ID, getOverview, type Overview } from '@vs/engine';
import { formatMinor, loadConfig, money, systemActor } from '@vs/shared';
import { backofficeDb } from '../../server/db';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Build progress · vessel-system' };

/**
 * TEMPORARY read-only progress page for the demo operator (local only). It shows what the engine
 * has built so far and is replaced by the real back-office screens in Batch 6.
 */
export default async function ProgressPage() {
  if (loadConfig().VS_ENV === 'hosted') notFound();
  const data = await getOverview(backofficeDb(), {
    operatorId: DEMO_OPERATOR_ID,
    actor: systemActor('progress-page'),
  });
  return (
    <div lang="en" dir="ltr" className="page">
      <style>{css}</style>
      <header className="top">
        <div>
          <p className="eyebrow">Temporary progress view · local only · read-only</p>
          <h1>
            {data.vessel?.name ?? 'No vessel'} · {data.operator.name}
          </h1>
          <p className="muted">
            Today in Cairo {data.today} · as of {time(data.asOf)} · replaced by the real screens in
            Batch 6
          </p>
        </div>
        <Invariants violations={data.invariants} />
      </header>

      <section className="stats">
        <Stat label="Open legs ahead" value={data.counts.legs} />
        <Stat label="Sailings on sale" value={data.counts.sailings} />
        <Stat label="Active holds" value={data.counts.activeHolds} />
        <Stat label="Quotes" value={data.counts.quotes} />
        <Stat label="Open exceptions" value={data.counts.openExceptions} />
        {Object.entries(data.counts.bookingsByStatus)
          .sort()
          .map(([status, n]) => (
            <Stat key={status} label={`Bookings · ${status}`} value={n} />
          ))}
      </section>

      <Availability data={data} />

      <section className="card">
        <h2>Bookings</h2>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Channel</th>
                <th>Cruise</th>
                <th>Embark</th>
                <th className="num">Cabins</th>
                <th className="num">Guests</th>
                <th className="num">Rev</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.bookings.map((b) => (
                <tr key={b.ref}>
                  <td className="mono">{b.ref}</td>
                  <td>
                    <span className={`pill ${b.status}`}>{b.status}</span>
                  </td>
                  <td>
                    <span className={`pill ${b.paymentStatus}`}>
                      {b.paymentStatus.replace('_', ' ')}
                    </span>
                  </td>
                  <td>{b.channel}</td>
                  <td>{b.pattern ?? '—'}</td>
                  <td>{b.embarkDate}</td>
                  <td className="num">{b.cabins}</td>
                  <td className="num">{b.guests}</td>
                  <td className="num">{b.revision}</td>
                  <td className="num">{amount(b.total, b.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two">
        <section className="card">
          <h2>Active holds</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Channel</th>
                  <th>Embark</th>
                  <th className="num">Cabins</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.holds.map((h, i) => (
                  <tr key={i}>
                    <td>
                      <span className={`pill ${h.kind}`}>{h.kind}</span>
                    </td>
                    <td>{h.channel}</td>
                    <td>{h.embarkDate}</td>
                    <td className="num">{h.cabins}</td>
                    <td>{time(h.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h2>Recent quotes</h2>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Channel</th>
                  <th>Cruise</th>
                  <th>Embark</th>
                  <th className="num">Total</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.quotes.map((q, i) => (
                  <tr key={i} className={q.expired ? 'faded' : undefined}>
                    <td>{q.channel}</td>
                    <td>{q.pattern ?? '—'}</td>
                    <td>{q.embarkDate}</td>
                    <td className="num">{amount(q.total, q.currency)}</td>
                    <td>{q.expired ? 'expired' : time(q.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <section className="card">
        <h2>Open exceptions (action list)</h2>
        {data.exceptions.length === 0 ? (
          <p className="muted">None.</p>
        ) : (
          <ul className="exceptions">
            {data.exceptions.map((e, i) => (
              <li key={i}>
                <span className={`pill ${e.severity}`}>{e.kind}</span> {e.summary}{' '}
                <span className="muted">· {time(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Availability({ data }: { data: Overview }) {
  const sailings = data.availability?.sailings ?? [];
  const capacity = new Map(data.categories.map((c) => [c.code, c.cabins]));
  return (
    <section className="card">
      <h2>Availability · next 6 weeks</h2>
      <p className="muted">
        Free cabins per sailing and category: the minimum across the sailing&apos;s legs (pool only,
        allotments excluded).
      </p>
      <div className="scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>Embark</th>
              <th>Cruise</th>
              <th>Route</th>
              {data.categories.map((c) => (
                <th key={c.code} className="num" title={c.name}>
                  {c.code} <span className="muted">/{c.cabins}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sailings.map((s) => (
              <tr key={s.sailingId}>
                <td>{s.embarkDate}</td>
                <td>
                  {s.patternCode} <span className="muted">({s.nights} n)</span>
                </td>
                <td>
                  {s.embarkPort} → {s.disembarkPort}
                </td>
                {s.categories.map((c) => {
                  const cap = capacity.get(c.code) ?? 1;
                  const level =
                    c.stopSale || c.free === 0
                      ? 'none'
                      : c.free / cap < 0.34
                        ? 'low'
                        : c.free < cap
                          ? 'some'
                          : 'all';
                  return (
                    <td key={c.categoryId} className={`num cell ${level}`}>
                      {c.stopSale ? 'stop' : c.free}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Invariants({ violations }: { violations: Overview['invariants'] }) {
  return violations.length === 0 ? (
    <div className="badge ok">
      <strong>0</strong> invariant violations
    </div>
  ) : (
    <div className="badge bad">
      <strong>{violations.length}</strong> invariant violations
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

function amount(total: string, currency: string) {
  return formatMinor(money(BigInt(total), currency));
}

function time(value: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(value);
}

const css = `
:root { --bg:#f7f7f5; --card:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e6e4df; --accent:#0f6e6e;
  --ok:#1f7a3f; --okbg:#e6f4ea; --bad:#a3261c; --badbg:#fbe9e7; --amber:#8a5a00; --amberbg:#fdf2dc; --some:#eef6f0; }
@media (prefers-color-scheme: dark) { :root { --bg:#151514; --card:#1e1e1c; --text:#ecebe7; --muted:#a19f98; --line:#33322f;
  --accent:#5cc0c0; --ok:#7fd29a; --okbg:#1d3326; --bad:#f19a90; --badbg:#3a1f1c; --amber:#f0c46c; --amberbg:#3a2f17; --some:#1f2b23; } }
body { background: var(--bg); color: var(--text); }
.page { max-width: 1200px; margin: 0 auto; padding: 8px 0 48px; font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
h1 { font-size: 22px; margin: 4px 0; } h2 { font-size: 16px; margin: 0 0 10px; }
.eyebrow { text-transform: uppercase; letter-spacing: .06em; font-size: 11px; color: var(--accent); margin: 0; font-weight: 600; }
.muted { color: var(--muted); }
.top { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.badge { padding: 10px 14px; border-radius: 10px; font-size: 13px; } .badge strong { font-size: 20px; margin-right: 6px; }
.badge.ok { background: var(--okbg); color: var(--ok); } .badge.bad { background: var(--badbg); color: var(--bad); }
.stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
.stat { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
.stat .value { font-size: 22px; font-weight: 650; } .stat .label { color: var(--muted); font-size: 12px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; min-width: 0; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; } @media (max-width: 800px) { .two { grid-template-columns: 1fr; } }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { color: var(--muted); font-weight: 600; } .num { text-align: right; font-variant-numeric: tabular-nums; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.faded td { color: var(--muted); }
.cell { font-weight: 600; } .cell.all { color: var(--ok); } .cell.some { background: var(--some); }
.cell.low { background: var(--amberbg); color: var(--amber); } .cell.none { background: var(--badbg); color: var(--bad); }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: var(--line); }
.pill.confirmed, .pill.option { background: var(--okbg); color: var(--ok); }
.pill.held, .pill.requested, .pill.payment, .pill.checkout, .pill.warning { background: var(--amberbg); color: var(--amber); }
.pill.paid, .pill.deposit_paid { background: var(--okbg); color: var(--ok); }
.pill.refund_due, .pill.paid_unavailable { background: var(--badbg); color: var(--bad); }
.pill.cancelled, .pill.expired, .pill.critical { background: var(--badbg); color: var(--bad); }
.exceptions { margin: 0; padding-left: 18px; } .exceptions li { margin: 4px 0; }
@media (max-width: 600px) { .page { padding: 0 0 32px; } h1 { font-size: 18px; } }
`;
