'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DocumentButtons } from '../../../components/documents';
import { RangeNav, VesselSelect } from '../../../components/range-nav';
import { Alert, Badge, Button, Card, Empty, Select, cx } from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

const WINDOW = 14;

export function GuestsScreen({
  vessels,
  initialLeg,
  canAssign,
  canManifest,
  canDocuments,
}: {
  vessels: { id: string; name: string }[];
  initialLeg: string | null;
  canAssign: boolean;
  canManifest: boolean;
  canDocuments: boolean;
}) {
  const t = useTranslations('guests');
  const tc = useTranslations('common');
  const td = useTranslations('documents');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const [from, setFrom] = useState(() => cairoTodayIso());
  const [legId, setLegId] = useState<string | null>(initialLeg);
  const [notice, setNotice] = useState<string | null>(null);
  const departures = useQuery(
    trpc.guests.departures.queryOptions(
      { vesselId, from, to: addDaysIso(from, WINDOW - 1) },
      { enabled: Boolean(vesselId) },
    ),
  );
  const manifest = useQuery(
    trpc.guests.manifest.queryOptions({ legId: legId ?? '' }, { enabled: legId !== null }),
  );
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.guests.manifest.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.guests.departures.queryKey() }),
    ]);
  const autoAssign = useMutation(
    trpc.guests.autoAssign.mutationOptions({
      onSuccess: (r) => {
        setNotice(t('assigned', { assigned: r.assigned, split: r.split, unplaced: r.unplaced }));
        void refresh();
      },
    }),
  );
  const m = manifest.data;

  return (
    <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <Card
        title={t('departures')}
        actions={<VesselSelect vessels={vessels} value={vesselId} onChange={setVesselId} />}
      >
        <div className="mb-2">
          <RangeNav from={from} days={WINDOW} onChange={setFrom} />
        </div>
        {departures.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : !departures.data?.length ? (
          <Empty>{tc('none')}</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {departures.data.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => {
                    setLegId(d.id);
                    setNotice(null);
                  }}
                  className={cx(
                    'w-full rounded-lg border px-3 py-2 text-start text-sm',
                    legId === d.id
                      ? 'border-brand ring-2 ring-brand/20'
                      : 'border-line hover:border-brand',
                  )}
                >
                  <span className="font-medium">{formatDate(d.departDate, locale, 'long')}</span>
                  <span className="block text-xs text-muted" dir="ltr">
                    {d.from} → {d.to}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    <Badge tone="neutral">{t('parties', { n: d.parties })}</Badge>
                    {d.unassigned > 0 && (
                      <Badge tone="warn">{t('unassigned', { n: d.unassigned })}</Badge>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        {!legId ? (
          <Card>
            <Empty>{t('pick')}</Empty>
          </Card>
        ) : manifest.isLoading || !m ? (
          <Card>
            <Empty>{tc('loading')}</Empty>
          </Card>
        ) : (
          <>
            <Card
              title={
                <span>
                  {formatDate(m.leg.departDate, locale, 'long')} ·{' '}
                  {locale.startsWith('ar') ? m.leg.from.nameAr : m.leg.from.nameEn} –{' '}
                  {locale.startsWith('ar') ? m.leg.to.nameAr : m.leg.to.nameEn}
                  <span className="block text-sm font-normal text-muted">
                    {t('guestsCount', { n: m.parties.reduce((n, p) => n + p.guests.length, 0) })}
                  </span>
                </span>
              }
              actions={
                canAssign && (
                  <Button
                    variant="secondary"
                    disabled={autoAssign.isPending}
                    onClick={() =>
                      autoAssign.mutate({ vesselId: m.leg.vesselId, legIds: [m.leg.id] })
                    }
                  >
                    {t('autoAssign')}
                  </Button>
                )
              }
            >
              {notice && <Alert tone="ok">{notice}</Alert>}
              {autoAssign.isError && <Alert tone="bad">{errorText(autoAssign.error)}</Alert>}
              {m.parties.length === 0 ? (
                <Empty>{tc('none')}</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {m.parties.map((p) => (
                    <li
                      key={p.bookingCabinId}
                      className="flex flex-wrap items-start gap-3 py-3 text-sm"
                    >
                      <CabinCell party={p} canAssign={canAssign} onChanged={() => void refresh()} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/bookings/${p.ref}`}
                            className="font-medium text-brand"
                            dir="ltr"
                          >
                            {p.ref}
                          </Link>
                          <span className="text-muted">{p.channel}</span>
                          <Badge tone="neutral">
                            {locale.startsWith('ar') ? p.category.nameAr : p.category.nameEn}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted">
                          {t('boards', {
                            date: formatDate(p.embark.date, locale),
                            port: p.embark.port,
                          })}{' '}
                          ·{' '}
                          {t('leaves', {
                            date: formatDate(p.disembark.date, locale),
                            port: p.disembark.port,
                          })}
                        </p>
                        {p.guests.length === 0 ? (
                          <Badge tone="warn">{t('noGuests')}</Badge>
                        ) : (
                          <ul className="mt-1">
                            {p.guests.map((g, i) => (
                              <li key={i} className="flex flex-wrap items-center gap-2">
                                <span>
                                  {g.firstName} {g.lastName}
                                </span>
                                {g.nationality && (
                                  <span className="text-xs text-muted" dir="ltr">
                                    {g.nationality}
                                  </span>
                                )}
                                {g.dateOfBirth && (
                                  <span className="text-xs text-muted">
                                    {formatDate(g.dateOfBirth, locale)}
                                  </span>
                                )}
                                <Badge tone={g.hasPassport ? 'ok' : 'warn'}>
                                  {g.hasPassport ? t('passportOnFile') : t('noPassport')}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {canDocuments && (
              <Card title={t('exports')}>
                <DocumentButtons
                  items={[
                    ...(canManifest
                      ? ([
                          {
                            key: 'manifest-pdf',
                            label: `${td('manifest')} · ${t('pdf')}`,
                            input: { kind: 'manifest', legId: m.leg.id, format: 'pdf' },
                          },
                          {
                            key: 'manifest-xlsx',
                            label: `${td('manifest')} · ${t('xlsx')}`,
                            input: { kind: 'manifest', legId: m.leg.id, format: 'xlsx' },
                          },
                        ] as const)
                      : []),
                    {
                      key: 'rooming-pdf',
                      label: `${td('rooming_list')} · ${t('pdf')}`,
                      input: { kind: 'rooming_list', legId: m.leg.id, format: 'pdf' },
                    },
                    {
                      key: 'rooming-xlsx',
                      label: `${td('rooming_list')} · ${t('xlsx')}`,
                      input: { kind: 'rooming_list', legId: m.leg.id, format: 'xlsx' },
                    },
                  ]}
                />
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function CabinCell({
  party,
  canAssign,
  onChanged,
}: {
  party: { bookingCabinId: string; cabin: { number: string } | null };
  canAssign: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('guests');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const options = useQuery(
    trpc.guests.cabinOptions.queryOptions(
      { bookingCabinId: party.bookingCabinId },
      { enabled: editing },
    ),
  );
  const assign = useMutation(
    trpc.guests.assign.mutationOptions({
      onSuccess: () => {
        setEditing(false);
        onChanged();
      },
    }),
  );
  return (
    <div className="flex w-28 shrink-0 flex-col gap-1">
      <span className="text-xs text-muted">{t('cabin')}</span>
      {editing ? (
        <Select
          autoFocus
          value=""
          onChange={(e) =>
            assign.mutate({
              bookingCabinId: party.bookingCabinId,
              cabinId: e.target.value === '-' ? null : e.target.value,
            })
          }
        >
          <option value="" disabled>
            {t('choose')}
          </option>
          {options.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number}
              {c.deck ? ` · ${c.deck}` : ''}
            </option>
          ))}
          {party.cabin && <option value="-">{t('unassign')}</option>}
        </Select>
      ) : (
        <span className="text-lg font-semibold" dir="ltr">
          {party.cabin?.number ?? '—'}
        </span>
      )}
      {canAssign && !editing && (
        <button
          type="button"
          className="text-start text-xs text-brand"
          onClick={() => setEditing(true)}
        >
          {t('change')}
        </button>
      )}
      {assign.isError && <span className="text-xs text-bad">{errorText(assign.error)}</span>}
    </div>
  );
}
