'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Badge, Button, Field, Input, Select } from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDateTime, parseMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

export interface Vessel {
  id: string;
  name: string;
  categories: { id: string; code: string }[];
}

function Actions({
  onClose,
  disabled,
  label,
}: {
  onClose: () => void;
  disabled: boolean;
  label?: string;
}) {
  const tc = useTranslations('common');
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="secondary" onClick={onClose}>
        {tc('close')}
      </Button>
      <Button type="submit" disabled={disabled}>
        {label ?? tc('save')}
      </Button>
    </div>
  );
}

/** A secret shown exactly once, in a modal so it cannot scroll by unseen. */
export function SecretShown({
  label,
  value,
  onClose,
}: {
  label: string;
  value: string;
  onClose: () => void;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onClose={onClose} title={label}>
      <Alert tone="warn">{t('secretOnce')}</Alert>
      <code className="mt-3 block rounded-lg bg-line/40 p-3 text-xs break-all" dir="ltr">
        {value}
      </code>
      <div className="mt-3 flex justify-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? t('copied') : t('copy')}
        </Button>
        <Button type="button" onClick={onClose}>
          {tc('close')}
        </Button>
      </div>
    </Dialog>
  );
}

export function ChannelDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const t = useTranslations('channels');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [form, setForm] = useState({
    code: '',
    name: '',
    type: 'agent' as 'agent' | 'portal' | 'api',
    credit: '',
    currency: 'USD',
  });
  const credit = form.credit ? parseMoney(form.credit) : null;
  const create = useMutation(trpc.channels.create.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('newChannel')}>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            code: form.code.trim().toLowerCase(),
            name: form.name.trim(),
            type: form.type,
            creditAllowed: credit !== null,
            creditLimit: credit ?? undefined,
            creditCurrency: credit !== null ? (form.currency as 'USD') : undefined,
          });
        }}
      >
        <Field label={t('name')}>
          <Input
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </Field>
        <Field label={t('code')}>
          <Input
            required
            dir="ltr"
            pattern="[a-z][a-z0-9_\-]{1,31}"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value.toLowerCase() })}
          />
        </Field>
        <Field label={t('type')}>
          <Select
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value as typeof form.type })}
          >
            {(['agent', 'portal', 'api'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`type_${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('credit')}>
          <div className="flex gap-1">
            <Input
              inputMode="decimal"
              dir="ltr"
              value={form.credit}
              onChange={(e) => setForm({ ...form, credit: e.target.value })}
            />
            <Select
              className="w-24"
              value={form.currency}
              onChange={(e) => setForm({ ...form, currency: e.target.value })}
            >
              {['USD', 'EUR', 'EGP', 'GBP'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </div>
        </Field>
        {create.isError && (
          <div className="col-span-2">
            <Alert tone="bad">{errorText(create.error)}</Alert>
          </div>
        )}
        <div className="col-span-2">
          <Actions
            onClose={onClose}
            disabled={create.isPending || (form.credit !== '' && credit === null)}
          />
        </div>
      </form>
    </Dialog>
  );
}

export function ContractDialog({
  channelId,
  vessels,
  onClose,
  onDone,
}: {
  channelId: string;
  vessels: Vessel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('channels');
  const tb = useTranslations('book');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const vessel = vessels.find((v) => v.id === vesselId);
  const rates = useQuery(
    trpc.rates.setup.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const [form, setForm] = useState({
    allocation: 'pool' as 'pool' | 'allotment' | 'on_request',
    paymentMode: 'credit' as 'channel_collected' | 'vessel_prepaid' | 'credit',
    priceAdjustment: 'none' as 'none' | 'markup' | 'commission',
    percent: '0',
    validFrom: cairoTodayIso(),
  });
  const [plans, setPlans] = useState<Set<string>>(new Set());
  const percent = Number(form.percent);
  const create = useMutation(trpc.channels.createContract.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('newContract')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            channelId,
            vesselId,
            allocation: form.allocation,
            paymentMode: form.paymentMode,
            priceAdjustment: form.priceAdjustment,
            adjustmentBps: Math.round(percent * 100),
            validFrom: form.validFrom,
            categoryIds: vessel?.categories.map((c) => c.id) ?? [],
            ratePlanIds: [...plans],
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('vessel')}>
            <Select value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
              {vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('allocation')}>
            <Select
              value={form.allocation}
              onChange={(e) =>
                setForm({ ...form, allocation: e.target.value as typeof form.allocation })
              }
            >
              {(['pool', 'allotment', 'on_request'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`allocation_${k}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('paymentMode')}>
            <Select
              value={form.paymentMode}
              onChange={(e) =>
                setForm({ ...form, paymentMode: e.target.value as typeof form.paymentMode })
              }
            >
              {(['credit', 'channel_collected', 'vessel_prepaid'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`paymentMode_${k}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('from')}>
            <Input
              type="date"
              required
              value={form.validFrom}
              onChange={(e) => setForm({ ...form, validFrom: e.target.value })}
            />
          </Field>
          <Field label={t('adjustment')}>
            <Select
              value={form.priceAdjustment}
              onChange={(e) =>
                setForm({ ...form, priceAdjustment: e.target.value as typeof form.priceAdjustment })
              }
            >
              {(['none', 'markup', 'commission'] as const).map((k) => (
                <option key={k} value={k}>
                  {t(`adjustment_${k}`, { p: Number(form.percent) || 0 })}
                </option>
              ))}
            </Select>
          </Field>
          {form.priceAdjustment !== 'none' && (
            <Field label="%">
              <Input
                type="number"
                min={0}
                max={100}
                step="0.01"
                value={form.percent}
                onChange={(e) => setForm({ ...form, percent: e.target.value })}
              />
            </Field>
          )}
        </div>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">{t('ratePlans')}</legend>
          <div className="flex flex-col gap-1 text-sm">
            {rates.data?.plans.map((p) => (
              <label key={p.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={plans.has(p.id)}
                  onChange={() => {
                    const next = new Set(plans);
                    if (next.has(p.id)) next.delete(p.id);
                    else next.add(p.id);
                    setPlans(next);
                  }}
                />
                {p.code} · {tb.has(`market_${p.market}`) ? tb(`market_${p.market}`) : p.market} ·{' '}
                {p.currency}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{t('allCategoriesNote')}</p>
        </fieldset>
        {create.isError && <Alert tone="bad">{errorText(create.error)}</Alert>}
        <Actions
          onClose={onClose}
          disabled={plans.size === 0 || Number.isNaN(percent) || create.isPending}
        />
      </form>
    </Dialog>
  );
}

export function AllotmentDialog({
  channelId,
  vessels,
  onClose,
  onDone,
}: {
  channelId: string;
  vessels: Vessel[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('channels');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const ti = useTranslations('inventory');
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const vessel = vessels.find((v) => v.id === vesselId);
  const [range, setRange] = useState(() => ({
    from: cairoTodayIso(),
    to: addDaysIso(cairoTodayIso(), 60),
  }));
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [releaseDays, setReleaseDays] = useState('');
  const grid = useQuery(
    trpc.inventory.grid.queryOptions(
      { vesselId, from: range.from, to: range.to },
      { enabled: Boolean(vesselId && range.from && range.to && range.to >= range.from) },
    ),
  );
  const legIds = grid.data?.legs.filter((l) => l.status === 'open').map((l) => l.id) ?? [];
  const categories = Object.entries(counts)
    .map(([categoryId, n]) => ({ categoryId, cabins: Number(n) }))
    .filter((c) => Number.isInteger(c.cabins) && c.cabins > 0);
  const create = useMutation(trpc.channels.createAllotment.mutationOptions({ onSuccess: onDone }));
  return (
    <Dialog open onClose={onClose} title={t('newAllotment')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            channelId,
            vesselId,
            legIds,
            categories,
            releaseDays: releaseDays ? Number(releaseDays) : undefined,
          });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          {vessels.length > 1 && (
            <Field label={t('vessel')}>
              <Select value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
                {vessels.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('from')}>
            <Input
              type="date"
              value={range.from}
              onChange={(e) => setRange({ ...range, from: e.target.value })}
            />
          </Field>
          <Field label={t('to')}>
            <Input
              type="date"
              value={range.to}
              onChange={(e) => setRange({ ...range, to: e.target.value })}
            />
          </Field>
        </div>
        <p className="text-sm text-muted">{ti('legs', { n: legIds.length })}</p>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">{t('categoriesCabins')}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {vessel?.categories.map((c) => (
              <Field key={c.id} label={c.code}>
                <Input
                  type="number"
                  min={0}
                  max={200}
                  value={counts[c.id] ?? ''}
                  onChange={(e) => setCounts({ ...counts, [c.id]: e.target.value })}
                />
              </Field>
            ))}
          </div>
        </fieldset>
        <Field label={t('releaseDays', { n: Number(releaseDays) || 0 })}>
          <Input
            type="number"
            min={0}
            max={400}
            value={releaseDays}
            onChange={(e) => setReleaseDays(e.target.value)}
          />
        </Field>
        {create.isError && <Alert tone="bad">{errorText(create.error)}</Alert>}
        <Actions
          onClose={onClose}
          disabled={legIds.length === 0 || categories.length === 0 || create.isPending}
        />
      </form>
    </Dialog>
  );
}

export function ClientDialog({
  channelId,
  onClose,
  onDone,
}: {
  channelId: string;
  onClose: () => void;
  onDone: (shown: { label: string; value: string }) => void;
}) {
  const t = useTranslations('channels');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [name, setName] = useState('');
  const create = useMutation(
    trpc.channels.createClient.mutationOptions({
      onSuccess: (r) => onDone({ label: `${t('clientId')}: ${r.clientId}`, value: r.secret }),
    }),
  );
  return (
    <Dialog open onClose={onClose} title={t('newClient')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({ channelId, name: name.trim() });
        }}
      >
        <Field label={t('name')}>
          <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {create.isError && <Alert tone="bad">{errorText(create.error)}</Alert>}
        <Actions onClose={onClose} disabled={!name.trim() || create.isPending} />
      </form>
    </Dialog>
  );
}

export function EndpointDialog({
  channelId,
  onClose,
  onDone,
}: {
  channelId: string;
  onClose: () => void;
  onDone: (shown: { label: string; value: string }) => void;
}) {
  const t = useTranslations('channels');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [url, setUrl] = useState('https://');
  const [types, setTypes] = useState('');
  const eventTypes = types
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const create = useMutation(
    trpc.channels.createEndpoint.mutationOptions({
      onSuccess: (r) => onDone({ label: url, value: r.secret }),
    }),
  );
  return (
    <Dialog open onClose={onClose} title={t('newEndpoint')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate({
            channelId,
            url: url.trim(),
            eventTypes: eventTypes.length ? eventTypes : undefined,
          });
        }}
      >
        <Field label={t('url')}>
          <Input
            required
            type="url"
            dir="ltr"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label={t('eventTypes')}>
          <Input
            dir="ltr"
            placeholder="booking.confirmed, booking.cancelled"
            value={types}
            onChange={(e) => setTypes(e.target.value)}
          />
        </Field>
        {create.isError && <Alert tone="bad">{errorText(create.error)}</Alert>}
        <Actions onClose={onClose} disabled={create.isPending} />
      </form>
    </Dialog>
  );
}

export function DeliveriesDialog({
  endpointId,
  url,
  canReplay,
  onClose,
}: {
  endpointId: string;
  url: string;
  canReplay: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('channels');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [status, setStatus] = useState<'' | 'pending' | 'delivered' | 'dead'>('');
  const input = { endpointId, status: status || undefined };
  const deliveries = useQuery(trpc.channels.deliveries.queryOptions(input));
  const replay = useMutation(
    trpc.channels.replay.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.channels.deliveries.queryKey() }),
    }),
  );
  return (
    <Dialog open onClose={onClose} title={t('deliveries')}>
      <p className="mb-2 truncate text-xs text-muted" dir="ltr">
        {url}
      </p>
      <Select
        className="mb-3"
        value={status}
        onChange={(e) => setStatus(e.target.value as typeof status)}
      >
        <option value="">—</option>
        <option value="pending">{t('pending')}</option>
        <option value="delivered">{t('delivered')}</option>
        <option value="dead">{t('dead')}</option>
      </Select>
      {replay.isError && <Alert tone="bad">{errorText(replay.error)}</Alert>}
      <ul className="divide-y divide-line text-sm">
        {deliveries.data?.length === 0 && <li className="py-2 text-muted">{t('none')}</li>}
        {deliveries.data?.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <span className="min-w-0">
              <span dir="ltr">{d.eventType}</span>{' '}
              <Badge tone={d.status === 'delivered' ? 'ok' : d.status === 'dead' ? 'bad' : 'warn'}>
                {t(d.status as 'pending')}
              </Badge>
              <span className="block text-xs text-muted">
                {formatDateTime(d.createdAt, locale)} · {t('attempts', { n: d.attempts })}
                {d.lastStatusCode !== null && ` · ${t('statusCode', { code: d.lastStatusCode })}`}
                {d.lastError && <span dir="ltr"> · {d.lastError}</span>}
              </span>
            </span>
            {canReplay && d.status !== 'pending' && (
              <Button
                variant="ghost"
                disabled={replay.isPending}
                onClick={() => replay.mutate({ deliveryId: d.id })}
              >
                {t('replay')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
