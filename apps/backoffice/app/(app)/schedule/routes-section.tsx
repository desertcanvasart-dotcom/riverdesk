'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import {
  Alert,
  Badge,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Select,
  Table,
  Td,
} from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { formatDate } from '../../../lib/format';
import { itineraryCode, leaveOptions, routeLegs, type EditStop } from '../../../lib/routes';
import { useTRPC } from '../../../lib/trpc';
import { PortsCard, type Port } from './ports-card';
import { useRouteError } from './route-errors';

interface Stop {
  seq: number;
  portId: string;
  dayOffset: number;
  arriveTime: string | null;
  departTime: string | null;
  embarkAllowed: boolean;
  disembarkAllowed: boolean;
}
interface Itinerary {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  embarkStopSeq: number;
  disembarkStopSeq: number;
  disembarkCycleOffset: number;
  nights: number;
  active: boolean;
  sailings: number;
}
interface Route {
  id: string;
  name: string;
  cycleDays: number;
  validFrom: string;
  validTo: string | null;
  stops: Stop[];
  itineraries: Itinerary[];
  legs: number;
  upcomingLegs: number;
  lastDeparture: string | null;
}

/** Ports, routes and itineraries of one ship, on the Schedule screen. */
export function RoutesSection({ vesselId, canWrite }: { vesselId: string; canWrite: boolean }) {
  const t = useTranslations('routes');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routeError = useRouteError();
  const data = useQuery(
    trpc.routes.list.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const [routeDialog, setRouteDialog] = useState<Route | 'add' | null>(null);
  const [itineraryDialog, setItineraryDialog] = useState<{
    route: Route;
    itinerary?: Itinerary;
  } | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.routes.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.schedule.setup.queryKey() });
  };
  const removeRoute = useMutation(trpc.routes.deleteRoute.mutationOptions({ onSuccess: refresh }));
  const removeItinerary = useMutation(
    trpc.routes.deleteItinerary.mutationOptions({ onSuccess: refresh }),
  );
  const ports = data.data?.ports ?? [];
  const routes = data.data?.routes ?? [];
  const portName = (id: string) => {
    const port = ports.find((p) => p.id === id);
    return port ? (locale.startsWith('ar') ? port.nameAr : port.nameEn) : '?';
  };
  const failed = removeRoute.error ?? removeItinerary.error;

  if (data.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <>
      <Card
        title={t('routes')}
        actions={
          canWrite && (
            <Button
              variant="secondary"
              disabled={!ports.some((p) => p.active)}
              title={!ports.some((p) => p.active) ? t('portsFirst') : undefined}
              onClick={() => setRouteDialog('add')}
            >
              + {t('addRoute')}
            </Button>
          )
        }
      >
        {failed && (
          <div className="mb-3">
            <Alert tone="bad">{routeError(failed)}</Alert>
          </div>
        )}
        {routes.length === 0 ? (
          <p className="text-sm text-muted">{ports.length ? t('noRoutes') : t('portsFirst')}</p>
        ) : (
          <div className="flex flex-col divide-y divide-line">
            {routes.map((r) => (
              <section key={r.id} className="py-4 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="font-semibold">{r.name}</h3>
                    <p className="text-sm text-muted">
                      {t('every', {
                        n: r.cycleDays,
                        weekday: weekday(r.validFrom, locale),
                        date: formatDate(r.validFrom, locale),
                      })}
                      {r.validTo && ` · ${t('until', { date: formatDate(r.validTo, locale) })}`}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex gap-1">
                      <Button variant="ghost" onClick={() => setRouteDialog(r)}>
                        {t('edit')}
                      </Button>
                      {r.legs === 0 && r.itineraries.length === 0 && (
                        <Button
                          variant="ghost"
                          disabled={removeRoute.isPending}
                          onClick={() => {
                            if (window.confirm(t('deleteRouteConfirm', { name: r.name })))
                              removeRoute.mutate({ routeId: r.id });
                          }}
                        >
                          {t('delete')}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                <ol className="mt-2 flex flex-wrap gap-1">
                  {r.stops.map((s) => (
                    <li key={s.seq}>
                      <Badge tone={s.embarkAllowed || s.disembarkAllowed ? 'info' : 'neutral'}>
                        {t('day', { n: s.dayOffset })} · {portName(s.portId)}
                        {s.departTime && ` · ${s.departTime}`}
                      </Badge>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-xs text-muted">
                  {r.legs === 0
                    ? t('noDepartures')
                    : t('departures', {
                        n: r.upcomingLegs,
                        date: r.lastDeparture ? formatDate(r.lastDeparture, locale) : '—',
                      })}
                </p>

                <div className="mt-3 flex items-center justify-between gap-2">
                  <h4 className="text-sm font-medium">{t('itineraries')}</h4>
                  {canWrite && (
                    <Button variant="ghost" onClick={() => setItineraryDialog({ route: r })}>
                      + {t('addItinerary')}
                    </Button>
                  )}
                </div>
                {r.itineraries.length === 0 ? (
                  <p className="text-sm text-muted">{t('noItineraries')}</p>
                ) : (
                  <Table
                    head={[
                      t('code'),
                      t('itineraryName'),
                      t('boardLeave'),
                      t('nights'),
                      t('sailings'),
                      '',
                    ]}
                  >
                    {r.itineraries.map((i) => (
                      <tr key={i.id} className={i.active ? '' : 'opacity-60'}>
                        <Td>
                          <span className="font-medium" dir="ltr">
                            {i.code}
                          </span>
                        </Td>
                        <Td>
                          {locale.startsWith('ar') ? i.nameAr : i.nameEn}
                          {!i.active && (
                            <span className="ms-2">
                              <Badge>{t('paused')}</Badge>
                            </span>
                          )}
                        </Td>
                        <Td>
                          {portName(r.stops[i.embarkStopSeq]?.portId ?? '')} {arrow(locale)}{' '}
                          {portName(r.stops[i.disembarkStopSeq]?.portId ?? '')}
                        </Td>
                        <Td>{i.nights}</Td>
                        <Td>{i.sailings}</Td>
                        <Td>
                          {canWrite && (
                            <div className="flex gap-1">
                              <Button
                                variant="ghost"
                                onClick={() => setItineraryDialog({ route: r, itinerary: i })}
                              >
                                {t('edit')}
                              </Button>
                              {i.sailings === 0 && (
                                <Button
                                  variant="ghost"
                                  disabled={removeItinerary.isPending}
                                  onClick={() => {
                                    if (
                                      window.confirm(t('deleteItineraryConfirm', { code: i.code }))
                                    )
                                      removeItinerary.mutate({ itineraryId: i.id });
                                  }}
                                >
                                  {t('delete')}
                                </Button>
                              )}
                            </div>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                )}
                {r.itineraries.some((i) => i.active) && r.legs === 0 && (
                  <div className="mt-3">
                    <Alert tone="info">{t('generateHint')}</Alert>
                  </div>
                )}
              </section>
            ))}
          </div>
        )}
      </Card>

      <PortsCard ports={ports} canWrite={canWrite} />

      <RouteDialog
        vesselId={vesselId}
        route={routeDialog}
        ports={ports}
        onClose={() => setRouteDialog(null)}
        onDone={refresh}
      />
      <ItineraryDialog
        state={itineraryDialog}
        ports={ports}
        onClose={() => setItineraryDialog(null)}
        onDone={refresh}
      />
    </>
  );
}

/** Points the way the text reads. */
const arrow = (locale: string) => (locale.startsWith('ar') ? '←' : '→');

function weekday(date: string, locale: string) {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
}

interface FormStop extends EditStop {
  arriveTime: string;
  departTime: string;
}

/** Next Monday after today (Cairo): a sensible first cycle for a weekly route. */
function nextMonday() {
  const today = cairoTodayIso();
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDaysIso(today, (8 - day) % 7 || 7);
}

function RouteDialog({
  vesselId,
  route,
  ports,
  onClose,
  onDone,
}: {
  vesselId: string;
  route: Route | 'add' | null;
  ports: Port[];
  onClose: () => void;
  onDone: () => void;
}) {
  if (!route) return null;
  return (
    <RouteForm
      key={route === 'add' ? 'add' : route.id}
      vesselId={vesselId}
      route={route === 'add' ? undefined : route}
      ports={ports}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function RouteForm({
  vesselId,
  route,
  ports,
  onClose,
  onDone,
}: {
  vesselId: string;
  route?: Route;
  ports: Port[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('routes');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const routeError = useRouteError();
  const active = ports.filter((p) => p.active || route?.stops.some((s) => s.portId === p.id));
  const stopsFixed = Boolean(route && (route.legs > 0 || route.itineraries.length > 0));
  const [name, setName] = useState(route?.name ?? '');
  const [cycleDays, setCycleDays] = useState(route?.cycleDays ?? 7);
  const [validFrom, setValidFrom] = useState(route?.validFrom ?? nextMonday());
  const [validTo, setValidTo] = useState(route?.validTo ?? '');
  const [stops, setStops] = useState<FormStop[]>(() =>
    route
      ? route.stops.map((s) => ({
          portId: s.portId,
          dayOffset: s.dayOffset,
          boarding: s.embarkAllowed || s.disembarkAllowed,
          arriveTime: s.arriveTime ?? '',
          departTime: s.departTime ?? '',
        }))
      : [
          {
            portId: active[0]?.id ?? '',
            dayOffset: 0,
            boarding: true,
            arriveTime: '',
            departTime: '',
          },
          {
            portId: active[0]?.id ?? '',
            dayOffset: 7,
            boarding: true,
            arriveTime: '',
            departTime: '',
          },
        ],
  );
  const add = useMutation(trpc.routes.addRoute.mutationOptions());
  const replace = useMutation(trpc.routes.replaceStops.mutationOptions());
  const update = useMutation(trpc.routes.updateRoute.mutationOptions());
  const failed = add.error ?? replace.error ?? update.error;
  const busy = add.isPending || replace.isPending || update.isPending;

  // The first stop is day 0 and the last one closes the cycle at the same port: both are boarding.
  const set = (index: number, patch: Partial<FormStop>) =>
    setStops((list) => {
      const next = list.map((s, i) => (i === index ? { ...s, ...patch } : s));
      next[0] = { ...next[0]!, dayOffset: 0, boarding: true };
      next[next.length - 1] = {
        ...next[next.length - 1]!,
        portId: next[0]!.portId,
        dayOffset: cycleDays,
        boarding: true,
      };
      return next;
    });
  const setCycle = (days: number) => {
    setCycleDays(days);
    setStops((list) => list.map((s, i) => (i === list.length - 1 ? { ...s, dayOffset: days } : s)));
  };
  const addStop = () =>
    setStops((list) => {
      const before = list[list.length - 2]!;
      const day = Math.min(before.dayOffset + 1, cycleDays);
      return [
        ...list.slice(0, -1),
        {
          portId: active[0]?.id ?? '',
          dayOffset: day,
          boarding: false,
          arriveTime: '',
          departTime: '',
        },
        list[list.length - 1]!,
      ];
    });
  const removeStop = (index: number) => setStops((list) => list.filter((_, i) => i !== index));
  const portName = (id: string) => {
    const port = ports.find((p) => p.id === id);
    return port ? (locale.startsWith('ar') ? port.nameAr : port.nameEn) : '?';
  };
  const legs = routeLegs(stops);
  const payloadStops = stops.map((s) => ({
    portId: s.portId,
    dayOffset: s.dayOffset,
    arriveTime: s.arriveTime || undefined,
    departTime: s.departTime || undefined,
    embarkAllowed: s.boarding,
    disembarkAllowed: s.boarding,
  }));

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={route ? `${t('editRoute')} · ${route.name}` : t('addRoute')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (!route) {
              await add.mutateAsync({
                vesselId,
                name: name.trim(),
                cycleDays,
                validFrom,
                validTo: validTo || undefined,
                stops: payloadStops,
              });
            } else {
              if (!stopsFixed)
                await replace.mutateAsync({
                  routeId: route.id,
                  cycleDays,
                  validFrom,
                  stops: payloadStops,
                });
              await update.mutateAsync({
                routeId: route.id,
                name: name.trim(),
                validTo: validTo || null,
              });
            }
            onDone();
            onClose();
          } catch {
            // Shown below from the mutation's error.
          }
        }}
      >
        <Field label={t('routeName')} hint={t('routeNameHint')}>
          <Input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('cycleDays')} hint={t('cycleDaysHint')}>
            <Input
              type="number"
              min={1}
              max={60}
              required
              disabled={stopsFixed}
              value={cycleDays}
              onChange={(e) => setCycle(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label={t('firstDeparture')} hint={weekday(validFrom, locale)}>
            <Input
              type="date"
              required
              disabled={stopsFixed}
              value={validFrom}
              onChange={(e) => setValidFrom(e.target.value)}
            />
          </Field>
          <Field label={t('endsOn')} hint={t('endsOnHint')}>
            <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
          </Field>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('stops')}</legend>
          {stopsFixed && <p className="text-xs text-muted">{t('stopsFixed')}</p>}
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-max text-sm">
              <thead>
                <tr className="text-start text-xs text-muted">
                  <th className="px-1 text-start font-medium">{t('port')}</th>
                  <th className="px-1 text-start font-medium">{t('dayCol')}</th>
                  <th className="px-1 text-start font-medium">{t('arrive')}</th>
                  <th className="px-1 text-start font-medium">{t('depart')}</th>
                  <th className="px-1 text-start font-medium">{t('boarding')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stops.map((s, i) => {
                  const end = i === 0 || i === stops.length - 1;
                  return (
                    <tr key={i}>
                      <td className="p-1">
                        <Select
                          value={s.portId}
                          disabled={stopsFixed || i === stops.length - 1}
                          onChange={(e) => set(i, { portId: e.target.value })}
                        >
                          {active.map((p) => (
                            <option key={p.id} value={p.id}>
                              {locale.startsWith('ar') ? p.nameAr : p.nameEn}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          className="w-20"
                          min={0}
                          max={cycleDays}
                          disabled={stopsFixed || end}
                          value={s.dayOffset}
                          onChange={(e) => set(i, { dayOffset: Number(e.target.value) || 0 })}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="time"
                          className="w-28"
                          disabled={stopsFixed}
                          value={s.arriveTime}
                          onChange={(e) => set(i, { arriveTime: e.target.value })}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="time"
                          className="w-28"
                          disabled={stopsFixed}
                          value={s.departTime}
                          onChange={(e) => set(i, { departTime: e.target.value })}
                        />
                      </td>
                      <td className="p-1 text-center">
                        <input
                          type="checkbox"
                          className="size-4"
                          aria-label={t('boarding')}
                          disabled={stopsFixed || end}
                          checked={s.boarding}
                          onChange={(e) => set(i, { boarding: e.target.checked })}
                        />
                      </td>
                      <td className="p-1">
                        {!stopsFixed && !end && (
                          <Button type="button" variant="ghost" onClick={() => removeStop(i)}>
                            ×
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!stopsFixed && (
            <div>
              <Button type="button" variant="ghost" onClick={addStop} disabled={stops.length >= 60}>
                + {t('addStop')}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted">{t('stopsHelp')}</p>
        </fieldset>

        {legs.length > 0 && (
          <div className="rounded-lg bg-line/30 p-3 text-sm">
            <h3 className="mb-1 font-medium">{t('preview')}</h3>
            <ul>
              {legs.map((leg, i) => (
                <li key={i}>
                  {portName(leg.from)} {arrow(locale)} {portName(leg.to)} ·{' '}
                  {t('nightsN', { n: leg.nights })}
                </li>
              ))}
            </ul>
          </div>
        )}
        {failed && <Alert tone="bad">{routeError(failed)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={busy}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "4 nights from Luxor" / «٤ ليالٍ من الأقصر»: a starting name staff can change. */
function suggestedNames(nights: number, port?: Port) {
  if (!port) return { nameEn: '', nameAr: '' };
  const ar = new Intl.NumberFormat('ar-EG').format(nights);
  const arNights =
    nights === 1
      ? 'ليلة واحدة'
      : nights === 2
        ? 'ليلتان'
        : nights <= 10
          ? `${ar} ليالٍ`
          : `${ar} ليلة`;
  return {
    nameEn: `${nights} ${nights === 1 ? 'night' : 'nights'} from ${port.nameEn}`,
    nameAr: `${arNights} من ${port.nameAr}`,
  };
}

function ItineraryDialog({
  state,
  ports,
  onClose,
  onDone,
}: {
  state: { route: Route; itinerary?: Itinerary } | null;
  ports: Port[];
  onClose: () => void;
  onDone: () => void;
}) {
  if (!state) return null;
  return (
    <ItineraryForm
      key={state.itinerary?.id ?? `add-${state.route.id}`}
      route={state.route}
      itinerary={state.itinerary}
      ports={ports}
      onClose={onClose}
      onDone={onDone}
    />
  );
}

function ItineraryForm({
  route,
  itinerary,
  ports,
  onClose,
  onDone,
}: {
  route: Route;
  itinerary?: Itinerary;
  ports: Port[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('routes');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const routeError = useRouteError();
  const port = (seq: number) => ports.find((p) => p.id === route.stops[seq]?.portId);
  const portLabel = (seq: number) => {
    const p = port(seq);
    return p ? (locale.startsWith('ar') ? p.nameAr : p.nameEn) : '?';
  };
  const boardStops = route.stops.filter((s, i) => s.embarkAllowed && i < route.stops.length - 1);
  const [embarkSeq, setEmbarkSeq] = useState(boardStops[0]?.seq ?? 0);
  const options = leaveOptions(route.stops, route.cycleDays, embarkSeq);
  const [leave, setLeave] = useState(0);
  const chosen = options[leave] ?? options[0];
  const suggestion = suggestedNames(chosen?.nights ?? 0, port(embarkSeq));
  const [code, setCode] = useState<string | null>(null);
  const [nameEn, setNameEn] = useState<string | null>(itinerary?.nameEn ?? null);
  const [nameAr, setNameAr] = useState<string | null>(itinerary?.nameAr ?? null);
  const [active, setActive] = useState(itinerary?.active ?? true);
  const add = useMutation(trpc.routes.addItinerary.mutationOptions());
  const update = useMutation(trpc.routes.updateItinerary.mutationOptions());
  const failed = add.error ?? update.error;
  const suggestedCode = itineraryCode(port(embarkSeq)?.code ?? '', chosen?.nights ?? 0);

  return (
    <Dialog
      open
      onClose={onClose}
      title={itinerary ? `${t('editItinerary')} · ${itinerary.code}` : t('addItinerary')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (itinerary)
              await update.mutateAsync({
                itineraryId: itinerary.id,
                nameEn: (nameEn ?? '').trim(),
                nameAr: (nameAr ?? '').trim(),
                active,
              });
            else if (chosen)
              await add.mutateAsync({
                templateId: route.id,
                code: (code ?? suggestedCode).trim().toUpperCase(),
                nameEn: (nameEn ?? suggestion.nameEn).trim(),
                nameAr: (nameAr ?? suggestion.nameAr).trim(),
                embarkStopSeq: embarkSeq,
                disembarkStopSeq: chosen.seq,
                disembarkCycleOffset: chosen.offset,
              });
            onDone();
            onClose();
          } catch {
            // Shown below from the mutation's error.
          }
        }}
      >
        {itinerary ? (
          <p className="text-sm text-muted">
            {portLabel(itinerary.embarkStopSeq)} {arrow(locale)}{' '}
            {portLabel(itinerary.disembarkStopSeq)} · {t('nightsN', { n: itinerary.nights })}
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('boardAt')}>
                <Select
                  value={embarkSeq}
                  onChange={(e) => {
                    setEmbarkSeq(Number(e.target.value));
                    setLeave(0);
                  }}
                >
                  {boardStops.map((s) => (
                    <option key={s.seq} value={s.seq}>
                      {portLabel(s.seq)} · {t('day', { n: s.dayOffset })}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('leaveAt')}>
                <Select value={leave} onChange={(e) => setLeave(Number(e.target.value))}>
                  {options.map((o, i) => (
                    <option key={`${o.seq}-${o.offset}`} value={i}>
                      {portLabel(o.seq)} · {t('day', { n: o.dayOffset })}
                      {o.offset > 0 ? ` (${t('nextCycle')})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {chosen ? (
              <p className="text-sm font-medium">{t('nightsN', { n: chosen.nights })}</p>
            ) : (
              <Alert tone="warn">{t('noLeaveOption')}</Alert>
            )}
            <Field label={t('code')} hint={t('itineraryCodeHint')}>
              <Input
                required
                dir="ltr"
                className="uppercase"
                pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,23}"
                value={code ?? suggestedCode}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('nameEn')}>
            <Input
              required
              maxLength={100}
              dir="ltr"
              value={nameEn ?? suggestion.nameEn}
              onChange={(e) => setNameEn(e.target.value)}
            />
          </Field>
          <Field label={t('nameAr')}>
            <Input
              required
              maxLength={100}
              dir="rtl"
              value={nameAr ?? suggestion.nameAr}
              onChange={(e) => setNameAr(e.target.value)}
            />
          </Field>
        </div>
        {itinerary && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            {t('itineraryActive')}
          </label>
        )}
        {failed && <Alert tone="bad">{routeError(failed)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={add.isPending || update.isPending || (!itinerary && !chosen)}
          >
            {tc('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
