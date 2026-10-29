'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Mail, Search } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { DocumentButtons } from '../../../components/documents';
import { Alert, Badge, Button, Card, Empty, Field, Input, cx } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney, formatNumber } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

type Mark = 'passportsSeen' | 'cardsSigned' | 'keyHanded';
const MARKS: Mark[] = ['passportsSeen', 'cardsSigned', 'keyHanded'];

/**
 * Check-in: the departures boarding in the coming days, then one departure cabin by cabin, with
 * the reception's marks. Works on a phone at the gangway; refreshes itself every 15 seconds so the
 * office sees the desk's progress.
 */
export function CheckinScreen({
  canWrite,
  canPassports,
  canFleet,
  onboard,
}: {
  canWrite: boolean;
  canPassports: boolean;
  canFleet: boolean;
  onboard: boolean;
}) {
  const t = useTranslations('checkin');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const trpc = useTRPC();
  const departures = useQuery(trpc.checkin.departures.queryOptions({ days: 7 }));
  const [legId, setLegId] = useState<string | null>(null);
  useEffect(() => {
    if (!legId && departures.data?.departures[0]) setLegId(departures.data.departures[0].legId);
  }, [departures.data, legId]);

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('departures')}>
        {departures.isLoading ? (
          <Empty>{t('loading')}</Empty>
        ) : !departures.data?.departures.length ? (
          <Empty>{t('noDepartures')}</Empty>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {departures.data.departures.map((d) => (
              <button
                key={d.legId}
                type="button"
                onClick={() => setLegId(d.legId)}
                className={cx(
                  'min-w-44 shrink-0 rounded-xl border p-3 text-start',
                  d.legId === legId ? 'border-brand bg-brand/5' : 'border-line hover:bg-line/30',
                )}
              >
                <div className="text-sm font-semibold">{formatDate(d.departDate, locale)}</div>
                <div className="text-xs text-muted">
                  {d.vessel} · {isArabic ? d.fromAr : d.from} → {isArabic ? d.toAr : d.to}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs">
                  <Progress done={d.checkedIn} total={d.cabins} />
                  <span className="tabular-nums">
                    {formatNumber(d.checkedIn, locale)}/{formatNumber(d.cabins, locale)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {legId && (
        <Departure
          key={legId}
          legId={legId}
          canWrite={canWrite}
          canPassports={canPassports}
          onboard={onboard}
        />
      )}

      {canFleet && <VesselSettings />}
    </div>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  const share = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
      <span className="block h-full rounded-full bg-ok" style={{ width: `${share}%` }} />
    </span>
  );
}

function Departure({
  legId,
  canWrite,
  canPassports,
  onboard,
}: {
  legId: string;
  canWrite: boolean;
  canPassports: boolean;
  onboard: boolean;
}) {
  const t = useTranslations('checkin');
  const td = useTranslations('documents');
  const tg = useTranslations('guestDetails');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [search, setSearch] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const departure = useQuery(
    trpc.checkin.departure.queryOptions({ legId }, { refetchInterval: 15_000 }),
  );
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.checkin.departure.queryKey({ legId }) });
    void queryClient.invalidateQueries({ queryKey: trpc.checkin.departures.queryKey() });
  };
  const set = useMutation(trpc.checkin.set.mutationOptions({ onSuccess: refresh }));

  const parties = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (departure.data?.parties ?? []).filter(
      (p) =>
        (!onlyOpen || !p.checkin.checkedInAt) &&
        (!q ||
          p.ref.toLowerCase().includes(q) ||
          p.cabin?.number.toLowerCase().includes(q) ||
          p.guests.some((g) => `${g.firstName} ${g.lastName}`.toLowerCase().includes(q))),
    );
  }, [departure.data, search, onlyOpen]);

  if (departure.isLoading) return <Empty>{t('loading')}</Empty>;
  if (!departure.data) return null;
  const { leg, totals } = departure.data;
  const diets = Object.entries(totals.dietary);

  return (
    <>
      <Card
        title={
          <span>
            {leg.vessel} · {formatDate(leg.departDate, locale)}
            {leg.departTime && <span dir="ltr"> · {leg.departTime}</span>}
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('cabins')} value={formatNumber(totals.cabins, locale)} />
          <Stat label={t('guests')} value={formatNumber(totals.guests, locale)} />
          <Stat
            label={t('checkedIn')}
            value={`${formatNumber(totals.checkedIn, locale)}/${formatNumber(totals.cabins, locale)}`}
            tone={totals.checkedIn === totals.cabins && totals.cabins > 0 ? 'ok' : undefined}
          />
          <Stat
            label={t('toCheck')}
            value={formatNumber(totals.warnings, locale)}
            tone={totals.warnings ? 'warn' : undefined}
          />
        </div>
        {diets.length > 0 && (
          <p className="mt-3 text-sm">
            <span className="text-muted">{t('diets')}: </span>
            {diets.map(([k, n]) => `${tg(`dietary_${k}`)} ${formatNumber(n, locale)}`).join(' · ')}
          </p>
        )}
        <div className="mt-4">
          <DocumentButtons
            items={[
              {
                key: 'sheet',
                label: td('embarkation_sheet'),
                input: { kind: 'embarkation_sheet', legId, format: 'pdf' },
              },
              ...(canPassports
                ? ([
                    {
                      key: 'file-xlsx',
                      label: `${td('checkin_file')} · Excel`,
                      input: { kind: 'checkin_file', legId, format: 'xlsx' },
                    },
                    {
                      key: 'file-pdf',
                      label: `${td('checkin_file')} · PDF`,
                      input: { kind: 'checkin_file', legId, format: 'pdf' },
                    },
                    {
                      key: 'cards',
                      label: td('registration_cards'),
                      input: { kind: 'registration_cards', legId, format: 'pdf' },
                    },
                  ] as const)
                : []),
              // On-board operations (D3): kitchen, restaurant, housekeeping, transfer desk.
              {
                key: 'diets',
                label: td('diet_list'),
                input: { kind: 'diet_list', legId, format: 'pdf' },
              },
              {
                key: 'diets-xlsx',
                label: `${td('diet_list')} · Excel`,
                input: { kind: 'diet_list', legId, format: 'xlsx' },
              },
              {
                key: 'occasions',
                label: td('occasion_list'),
                input: { kind: 'occasion_list', legId, format: 'pdf' },
              },
              {
                key: 'doors',
                label: td('door_cards'),
                input: { kind: 'door_cards', legId, format: 'pdf' },
              },
              {
                key: 'leaving',
                label: td('disembarkation_list'),
                input: { kind: 'disembarkation_list', legId, format: 'pdf' },
              },
              {
                key: 'leaving-xlsx',
                label: `${td('disembarkation_list')} · Excel`,
                input: { kind: 'disembarkation_list', legId, format: 'xlsx' },
              },
              // The remaining stationery (D4).
              ...(
                [
                  'luggage_tags',
                  'excursion_list',
                  'table_plan',
                  'muster_list',
                  'feedback_forms',
                ] as const
              ).map((kind) => ({
                key: kind,
                label: td(kind),
                input: { kind, legId, format: 'pdf' as const },
              })),
              {
                key: 'housekeeping',
                label: td('housekeeping_sheet'),
                input: { kind: 'housekeeping_sheet', vesselId: leg.vesselId, date: leg.departDate },
              },
              {
                key: 'programme',
                label: td('daily_programme'),
                input: {
                  kind: 'daily_programme',
                  vesselId: leg.vesselId,
                  from: leg.departDate,
                  days: 7,
                },
              },
            ]}
          />
        </div>
        {canPassports && !onboard && <SendPack legId={legId} />}
      </Card>

      {set.isError && <Alert tone="bad">{errorText(set.error)}</Alert>}

      <div className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-56 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted ltr:left-3 rtl:right-3"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('search')}
            aria-label={t('search')}
            className="ltr:pl-9 rtl:pr-9"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyOpen}
            onChange={(e) => setOnlyOpen(e.target.checked)}
            className="size-4"
          />
          {t('onlyOpen')}
        </label>
      </div>

      {parties.length === 0 ? (
        <Empty>{t('nobody')}</Empty>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {parties.map((p) => {
            const done = !!p.checkin.checkedInAt;
            const toggle = (input: Partial<Record<Mark | 'checkedIn', boolean>>) =>
              set.mutate({ legId, bookingCabinId: p.bookingCabinId, ...input });
            return (
              <section
                key={p.bookingCabinId}
                className={cx(
                  'rounded-xl border bg-surface p-4',
                  done ? 'border-ok/50' : 'border-line',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-2xl font-bold tabular-nums" dir="ltr">
                      {p.cabin?.number ?? '—'}
                    </div>
                    <div className="text-xs text-muted">
                      {isArabic ? p.category.nameAr : p.category.nameEn} ·{' '}
                      <span dir="ltr">{p.ref}</span> · {p.channel}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {done ? (
                      <Badge tone="ok">
                        {t('checkedInAt', {
                          time: formatDateTime(p.checkin.checkedInAt!, locale),
                        })}
                      </Badge>
                    ) : (
                      <Badge>{t('waiting')}</Badge>
                    )}
                    {p.balance && p.balance.amount > 0n && (
                      <Badge tone="warn">
                        {t('toCollect')} {formatMoney(p.balance.amount, p.balance.currency, locale)}
                      </Badge>
                    )}
                  </div>
                </div>

                <ul className="mt-3 flex flex-col gap-2">
                  {p.guests.map((g, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-medium">
                        {g.lastName}, {g.firstName}
                      </span>{' '}
                      {g.nationality && (
                        <span className="text-xs text-muted" dir="ltr">
                          {g.nationality}
                        </span>
                      )}
                      <span className="ms-1 inline-flex flex-wrap gap-1 align-middle">
                        {g.dietary.map((d) => (
                          <Badge key={d} tone="info">
                            {tg(`dietary_${d}`)}
                          </Badge>
                        ))}
                        {g.allergies && <Badge tone="info">{tg('allergies')}</Badge>}
                        {g.hasMedicalNotes && <Badge tone="info">{tg('medicalNotes')}</Badge>}
                        {g.occasion && <Badge tone="brand">{tg(`occasion_${g.occasion}`)}</Badge>}
                      </span>
                      {g.warnings.map((w) => (
                        <div key={w} className="mt-0.5 flex items-center gap-1 text-xs text-warn">
                          <AlertTriangle aria-hidden className="size-3.5" />
                          {t(`warning_${w}`)}
                        </div>
                      ))}
                    </li>
                  ))}
                  {p.guests.length === 0 && <li className="text-sm text-muted">{t('noNames')}</li>}
                </ul>
                {p.guests.some((g) => g.arrivalDate || g.arrivalFlight) && (
                  <p className="mt-2 text-xs text-muted">
                    {t('arrival')}:{' '}
                    {p.guests
                      .filter((g) => g.arrivalDate || g.arrivalFlight)
                      .slice(0, 1)
                      .map(
                        (g) =>
                          `${g.arrivalDate ? formatDate(g.arrivalDate, locale) : ''} ${g.arrivalFlight ?? ''}`,
                      )}
                  </p>
                )}

                {canWrite && (
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {MARKS.map((mark) => (
                      <button
                        key={mark}
                        type="button"
                        disabled={set.isPending}
                        aria-pressed={p.checkin[mark]}
                        onClick={() => toggle({ [mark]: !p.checkin[mark] })}
                        className={cx(
                          'flex min-h-11 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-medium',
                          p.checkin[mark]
                            ? 'border-ok bg-ok-bg text-ok'
                            : 'border-line hover:bg-line/40',
                        )}
                      >
                        {p.checkin[mark] && <Check aria-hidden className="size-3.5" />}
                        {t(mark)}
                      </button>
                    ))}
                    <Button
                      variant={done ? 'secondary' : 'primary'}
                      disabled={set.isPending}
                      onClick={() =>
                        toggle(
                          done
                            ? { checkedIn: false }
                            : {
                                checkedIn: true,
                                passportsSeen: true,
                                cardsSigned: true,
                                keyHanded: true,
                              },
                        )
                      }
                      className="col-span-3 min-h-11"
                    >
                      {done ? t('undo') : t('checkIn')}
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="rounded-lg bg-line/30 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cx(
          'text-xl font-semibold tabular-nums',
          tone === 'ok' && 'text-ok',
          tone === 'warn' && 'text-warn',
        )}
      >
        {value}
      </div>
    </div>
  );
}

/** Emails the check-in pack to the vessel now, and shows the last sends. */
function SendPack({ legId }: { legId: string }) {
  const t = useTranslations('checkin');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const sends = useQuery(
    trpc.checkin.packSends.queryOptions(
      { legId },
      {
        refetchInterval: (q) => (q.state.data?.some((s) => s.status === 'pending') ? 5_000 : false),
      },
    ),
  );
  const send = useMutation(
    trpc.checkin.sendPack.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({
          queryKey: trpc.checkin.packSends.queryKey({ legId }),
        }),
    }),
  );
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => send.mutate({ legId })}
          disabled={send.isPending}
        >
          <Mail aria-hidden className="size-4" />
          {t('sendPack')}
        </Button>
        <span className="text-xs text-muted">{t('sendPackHelp')}</span>
      </div>
      {send.isError && (
        <div className="mt-2">
          <Alert tone="bad">{errorText(send.error)}</Alert>
        </div>
      )}
      {(sends.data?.length ?? 0) > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-xs">
          {sends.data!.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <Badge tone={s.status === 'sent' ? 'ok' : s.status === 'failed' ? 'bad' : 'neutral'}>
                {t(`pack_${s.status}`)}
              </Badge>
              <span dir="ltr">{s.sentTo}</span>
              <span className="text-muted">
                {formatDateTime(s.sentAt ?? s.createdAt, locale)} ·{' '}
                {t(s.trigger === 'scheduled' ? 'packScheduled' : 'packButton')}
              </span>
              {s.error && <span className="text-bad">{s.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Each vessel's on-board email and automatic check-in pack (owners). */
function VesselSettings() {
  const t = useTranslations('checkin');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const vessels = useQuery(trpc.checkin.vessels.queryOptions());
  const save = useMutation(
    trpc.checkin.updateVessel.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.checkin.vessels.queryKey() }),
    }),
  );
  if (!vessels.data?.length) return null;
  return (
    <Card title={t('vesselSettings')}>
      <p className="mb-3 text-sm text-muted">{t('vesselSettingsHelp')}</p>
      {save.isError && (
        <div className="mb-3">
          <Alert tone="bad">{errorText(save.error)}</Alert>
        </div>
      )}
      <div className="flex flex-col gap-4">
        {vessels.data.map((v) => (
          <form
            key={v.id}
            className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto] sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              const hours = String(form.get('hours') ?? '');
              save.mutate({
                vesselId: v.id,
                onboardEmail: String(form.get('email') ?? '').trim() || null,
                checkinPackHours: hours ? Number(hours) : null,
              });
            }}
          >
            <div className="text-sm font-medium sm:pb-2">{v.name}</div>
            <Field label={t('onboardEmail')}>
              <Input name="email" type="email" dir="ltr" defaultValue={v.onboardEmail ?? ''} />
            </Field>
            <Field label={t('packHours')}>
              <Input
                name="hours"
                type="number"
                min={1}
                max={72}
                placeholder={t('packOff')}
                defaultValue={v.checkinPackHours ?? ''}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={save.isPending}>
              {t('save')}
            </Button>
          </form>
        ))}
      </div>
    </Card>
  );
}
