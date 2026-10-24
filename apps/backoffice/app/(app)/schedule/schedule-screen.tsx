'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { RangeNav, VesselSelect } from '../../../components/range-nav';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  cx,
} from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatDateTime } from '../../../lib/format';
import { statusTone } from '../../../lib/status';
import { useTRPC } from '../../../lib/trpc';
import { RoutesSection } from './routes-section';

const WINDOW = 28;
type Kind = 'cancel' | 'shift' | 'port_change' | 'dry_dock';

export function ScheduleScreen({
  vessels,
  canWrite,
}: {
  vessels: { id: string; name: string }[];
  canWrite: boolean;
}) {
  const t = useTranslations('schedule');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const [from, setFrom] = useState(() => cairoTodayIso());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [kind, setKind] = useState<Kind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const setup = useQuery(
    trpc.schedule.setup.queryOptions(
      { vesselId, from, to: addDaysIso(from, WINDOW - 1) },
      { enabled: Boolean(vesselId) },
    ),
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.schedule.setup.queryKey() });
  const generate = useMutation(
    trpc.schedule.generate.mutationOptions({
      onSuccess: (r) => {
        setNotice(t('generated', { legs: r.legsCreated, sailings: r.sailingsCreated }));
        void refresh();
        void queryClient.invalidateQueries({ queryKey: trpc.routes.list.queryKey() });
      },
    }),
  );
  const data = setup.data;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const portName = (code: string) => {
    const port = data?.ports.find((p) => p.code === code);
    return port ? (locale.startsWith('ar') ? port.name_ar : port.name_en) : code;
  };

  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok">{notice}</Alert>}
      {generate.isError && <Alert tone="bad">{errorText(generate.error)}</Alert>}

      <Card
        title={t('departures')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <VesselSelect vessels={vessels} value={vesselId} onChange={setVesselId} />
            <RangeNav from={from} days={WINDOW} onChange={setFrom} />
          </div>
        }
      >
        {data?.lastDeparture && (
          <p className="mb-2 text-sm text-muted">
            {t('lastDeparture', { date: formatDate(data.lastDeparture, locale, 'long') })}
          </p>
        )}
        {setup.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : !data?.departures.length ? (
          <Empty>{tc('none')}</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {data.departures.map((d) => (
              <li
                key={d.id}
                className={cx(
                  'flex items-center gap-3 py-2 text-sm',
                  selected.has(d.id) && 'bg-brand/5',
                )}
              >
                {canWrite && (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0"
                    checked={selected.has(d.id)}
                    disabled={d.status !== 'open'}
                    onChange={() => toggle(d.id)}
                    aria-label={`${d.departDate} ${d.from}`}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-medium">
                    {formatDate(d.departDate, locale, 'long')} – {formatDate(d.arriveDate, locale)}
                  </span>
                  <span className="block text-xs text-muted">
                    {portName(d.from)} – {portName(d.to)}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1 text-xs text-muted">
                  {d.status !== 'open' && (
                    <Badge tone={statusTone(d.status)}>{t('kind_cancel')}</Badge>
                  )}
                  {(d.booked > 0 || d.held > 0) && (
                    <span>
                      {t('booked')} {d.booked}
                      {d.held > 0 && ` · ${t('held')} ${d.held}`}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canWrite && (
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-lg">
          {selected.size > 0 && (
            <>
              <Button variant="danger" onClick={() => setKind('cancel')}>
                {t('cancel')}
              </Button>
              <Button variant="secondary" onClick={() => setKind('shift')}>
                {t('shift')}
              </Button>
              <Button
                variant="secondary"
                disabled={selected.size !== 1}
                title={selected.size !== 1 ? t('selectOne') : undefined}
                onClick={() => setKind('port_change')}
              >
                {t('portChange')}
              </Button>
            </>
          )}
          <Button variant="secondary" onClick={() => setKind('dry_dock')}>
            {t('dryDock')}
          </Button>
          <Button
            variant="ghost"
            disabled={generate.isPending}
            onClick={() => generate.mutate({ vesselId })}
          >
            {t('generate')}
          </Button>
        </div>
      )}

      {vesselId && <RoutesSection vesselId={vesselId} canWrite={canWrite} />}

      <Card title={t('exceptions')}>
        {!data?.exceptions.length ? (
          <p className="text-sm text-muted">{tc('none')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {data.exceptions.map((e) => (
              <li key={e.id} className="py-2">
                <Badge tone="warn">{t(`kind_${e.kind}` as 'kind_cancel')}</Badge>{' '}
                {formatDate(e.dateFrom, locale)}
                {e.dateTo !== e.dateFrom && ` – ${formatDate(e.dateTo, locale)}`} · {e.reason}
                <span className="block text-xs text-muted">
                  {formatDateTime(e.createdAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ExceptionDialog
        kind={kind}
        vesselId={vesselId}
        legIds={[...selected]}
        ports={data?.ports ?? []}
        onClose={() => setKind(null)}
        onDone={() => {
          setKind(null);
          setSelected(new Set());
          setNotice(t('applied'));
          void refresh();
        }}
      />
    </div>
  );
}

function ExceptionDialog({
  kind,
  vesselId,
  legIds,
  ports,
  onClose,
  onDone,
}: {
  kind: Kind | null;
  vesselId: string;
  legIds: string[];
  ports: { id: string; code: string; name_en: string; name_ar: string }[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('schedule');
  const tc = useTranslations('common');
  const ts = useTranslations('status');
  const ti = useTranslations('inventory');
  const locale = useLocale();
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(1);
  const [fromPortId, setFromPortId] = useState('');
  const [toPortId, setToPortId] = useState('');
  const [range, setRange] = useState(() => ({
    from: cairoTodayIso(),
    to: addDaysIso(cairoTodayIso(), 14),
  }));
  const preview = useMutation(trpc.schedule.preview.mutationOptions());
  const change = useMutation(trpc.schedule.change.mutationOptions({ onSuccess: onDone }));
  if (!kind) return null;

  const base = { vesselId, reason: reason.trim() };
  const input =
    kind === 'cancel'
      ? { ...base, kind, legIds }
      : kind === 'shift'
        ? { ...base, kind, legIds, days }
        : kind === 'port_change'
          ? {
              ...base,
              kind,
              legId: legIds[0] ?? '',
              fromPortId: fromPortId || undefined,
              toPortId: toPortId || undefined,
            }
          : { ...base, kind, from: range.from, to: range.to };
  const p = preview.data;
  const reset = () => preview.reset();
  const title =
    kind === 'cancel'
      ? t('cancel')
      : kind === 'shift'
        ? t('shift')
        : kind === 'port_change'
          ? t('portChange')
          : t('dryDock');
  const portLabel = (port: (typeof ports)[number]) =>
    `${port.code} · ${locale.startsWith('ar') ? port.name_ar : port.name_en}`;

  return (
    <Dialog
      open
      onClose={() => {
        reset();
        onClose();
      }}
      title={title}
    >
      <div className="flex flex-col gap-3">
        {kind !== 'dry_dock' && (
          <p className="text-sm text-muted">{ti('selected', { n: legIds.length })}</p>
        )}
        {kind === 'shift' && (
          <Field label={t('days')}>
            <Input
              type="number"
              min={-14}
              max={14}
              value={days}
              onChange={(e) => {
                setDays(Number(e.target.value) || 0);
                reset();
              }}
            />
          </Field>
        )}
        {kind === 'port_change' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('fromPort')}>
              <Select value={fromPortId} onChange={(e) => (setFromPortId(e.target.value), reset())}>
                <option value="">{t('keepPort')}</option>
                {ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {portLabel(port)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('toPort')}>
              <Select value={toPortId} onChange={(e) => (setToPortId(e.target.value), reset())}>
                <option value="">{t('keepPort')}</option>
                {ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {portLabel(port)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {kind === 'dry_dock' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('from')}>
              <Input
                type="date"
                value={range.from}
                onChange={(e) => (setRange({ ...range, from: e.target.value }), reset())}
              />
            </Field>
            <Field label={t('to')}>
              <Input
                type="date"
                value={range.to}
                onChange={(e) => (setRange({ ...range, to: e.target.value }), reset())}
              />
            </Field>
          </div>
        )}
        <Field label={tc('reason')}>
          <Input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>

        {p && (
          <div className="rounded-lg bg-line/30 p-3 text-sm">
            <h3 className="mb-1 font-medium">{t('impact')}</h3>
            <ul className="list-inside list-disc">
              <li>{t('impactLegs', { n: p.legsChanged })}</li>
              <li>{t('impactSailings', { n: p.sailingsChanged })}</li>
              {p.sailingsClosed.length > 0 && (
                <li>{t('impactClosed', { n: p.sailingsClosed.length })}</li>
              )}
              {p.holds > 0 && <li>{t('impactHolds', { n: p.holds })}</li>}
            </ul>
            {p.bookings.length === 0 && p.holds === 0 && p.allotments.length === 0 ? (
              <p className="mt-2 text-ok">{t('noImpact')}</p>
            ) : (
              <>
                {p.bookings.length > 0 && (
                  <>
                    <h4 className="mt-2 font-medium">{t('impactBookings')}</h4>
                    <ul>
                      {p.bookings.map((b) => (
                        <li key={b.ref}>
                          <Link href={`/bookings/${b.ref}`} className="text-brand" dir="ltr">
                            {b.ref}
                          </Link>{' '}
                          · {b.channel} · {tc('cabins', { n: b.cabins })} · {ts(b.status)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {p.allotments.length > 0 && (
                  <>
                    <h4 className="mt-2 font-medium">{t('impactAllotments')}</h4>
                    <ul>
                      {p.allotments.map((a) => (
                        <li key={a.channel}>
                          {a.channel} · {tc('cabins', { n: a.cabins })}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
            {p.legs.length > 0 && (
              <p className="mt-2 text-xs text-muted">
                {p.legs.map((l) => formatDate(l.departDate, locale)).join(' · ')}
              </p>
            )}
          </div>
        )}
        {(preview.isError || change.isError) && (
          <Alert tone="bad">{errorText(preview.error ?? change.error)}</Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          {!p ? (
            <Button
              type="button"
              disabled={!reason.trim() || preview.isPending}
              onClick={() => preview.mutate(input)}
            >
              {t('preview')}
            </Button>
          ) : (
            <Button
              type="button"
              variant={kind === 'cancel' || kind === 'dry_dock' ? 'danger' : 'primary'}
              disabled={change.isPending}
              onClick={() => change.mutate(input)}
            >
              {t('apply')}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
