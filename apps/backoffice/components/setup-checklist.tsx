import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import type { ShipSetup } from '@vs/engine';
import { Card, cx } from './ui';

/** Where each setup step is done. */
const HREF: Record<ShipSetup['steps'][number]['step'], string> = {
  categories: '/fleet',
  cabins: '/fleet',
  route: '/schedule',
  itineraries: '/schedule',
  departures: '/schedule',
  seasons: '/rates',
  policies: '/rates',
  plan: '/rates',
  prices: '/rates',
  backOffice: '/rates',
};

/**
 * Getting started (Batch 8, step 4): for owners, what each ship still needs before the office
 * can sell it, in order, with a link to the screen that does it. Hidden once everything is done.
 */
export async function SetupChecklist({
  setup,
}: {
  setup: { ships: ShipSetup[]; team: number; opsEmail: boolean };
}) {
  const t = await getTranslations('setup');
  const ready = setup.ships.length > 0 && setup.ships.every((s) => s.steps.every((x) => x.done));
  if (ready && setup.team > 1 && setup.opsEmail) return null;
  return (
    <Card title={ready ? t('almostTitle') : t('title')}>
      {!ready && <p className="mb-3 text-sm text-muted">{t('intro')}</p>}
      {setup.ships.length === 0 && (
        <Link href="/fleet" className="font-medium text-brand hover:underline">
          → {t('firstShip')}
        </Link>
      )}
      <div className="flex flex-col gap-4">
        {setup.ships
          .filter((ship) => ship.steps.some((s) => !s.done))
          .map((ship) => {
            const next = ship.steps.find((s) => !s.done)!;
            const done = ship.steps.filter((s) => s.done).length;
            return (
              <section key={ship.vesselId}>
                <h3 className="text-sm font-semibold">
                  {ship.name}{' '}
                  <span className="font-normal text-muted">
                    · {t('progress', { done, total: ship.steps.length })}
                  </span>
                </h3>
                <ol className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  {ship.steps.map((s) => (
                    <li key={s.step}>
                      <Link
                        href={HREF[s.step]}
                        className={cx(
                          'flex items-start gap-2 rounded-md px-2 py-1 hover:bg-line/40',
                          s === next && 'bg-brand/10 font-medium',
                          s.done && 'text-muted',
                        )}
                      >
                        <span aria-hidden className={s.done ? 'text-ok' : 'text-muted'}>
                          {s.done ? '✓' : '○'}
                        </span>
                        <span>
                          {t(`steps.${s.step}`)}
                          {!s.done && s.detail
                            ? ` (${t(`details.${s.step}`, { n: s.detail })})`
                            : ''}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        {(setup.team <= 1 || !setup.opsEmail) && (
          <section>
            <h3 className="text-sm font-semibold">{t('company')}</h3>
            <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
              {setup.team <= 1 && (
                <li>
                  <Link
                    href="/settings"
                    className="flex gap-2 rounded-md px-2 py-1 hover:bg-line/40"
                  >
                    <span aria-hidden className="text-muted">
                      ○
                    </span>
                    {t('team')}
                  </Link>
                </li>
              )}
              {!setup.opsEmail && (
                <li>
                  <Link
                    href="/settings"
                    className="flex gap-2 rounded-md px-2 py-1 hover:bg-line/40"
                  >
                    <span aria-hidden className="text-muted">
                      ○
                    </span>
                    {t('opsEmail')}
                  </Link>
                </li>
              )}
            </ul>
          </section>
        )}
      </div>
    </Card>
  );
}
