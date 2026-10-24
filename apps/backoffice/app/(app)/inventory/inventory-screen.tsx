'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Table,
  Td,
  cx,
} from '../../../components/ui';
import { addDaysIso, cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { CapacityCard } from '../../../components/capacity-card';

interface Category {
  id: string;
  code: string;
  name_en: string;
  name_ar: string;
}
interface Vessel {
  id: string;
  name: string;
  categories: Category[];
}

const WINDOW = 14;
type Action = 'block' | 'emergency' | 'stop' | 'resume';

export function InventoryScreen({ vessels, canWrite }: { vessels: Vessel[]; canWrite: boolean }) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const vessel = vessels.find((v) => v.id === vesselId);
  const [from, setFrom] = useState(() => cairoTodayIso());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const input = { vesselId, from, to: addDaysIso(from, WINDOW - 1) };
  const grid = useQuery(trpc.inventory.grid.queryOptions(input, { enabled: Boolean(vesselId) }));
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.inventory.grid.queryKey() });
  const release = useMutation(
    trpc.inventory.release.mutationOptions({
      onSuccess: () => {
        setNotice(t('done'));
        void refresh();
      },
    }),
  );
  const categories = vessel?.categories ?? [];
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const categoryCode = (id: string) => categories.find((c) => c.id === id)?.code ?? '';

  return (
    <div className="flex flex-col gap-4">
      <Card
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <VesselSelect vessels={vessels} value={vesselId} onChange={setVesselId} />
            <RangeNav from={from} days={WINDOW} onChange={setFrom} />
          </div>
        }
        title={<span className="text-sm font-normal text-muted">{t('legend')}</span>}
      >
        {notice && (
          <div className="mb-3">
            <Alert tone="ok">{notice}</Alert>
          </div>
        )}
        {grid.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : !grid.data?.legs.length ? (
          <Empty>{tc('none')}</Empty>
        ) : (
          <Table
            head={[
              canWrite ? '' : null,
              t('leg'),
              ...categories.map((c) => (
                <span key={c.id} title={locale.startsWith('ar') ? c.name_ar : c.name_en}>
                  {c.code}
                </span>
              )),
            ].filter((h) => h !== null)}
          >
            {grid.data.legs.map((leg) => (
              <tr key={leg.id} className={cx(selected.has(leg.id) && 'bg-brand/5')}>
                {canWrite && (
                  <Td>
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={selected.has(leg.id)}
                      disabled={leg.status !== 'open'}
                      onChange={() => toggle(leg.id)}
                      aria-label={`${leg.departDate} ${leg.from}`}
                    />
                  </Td>
                )}
                <Td className="whitespace-nowrap">
                  <span className="font-medium">{formatDate(leg.departDate, locale, 'long')}</span>
                  <span className="block text-xs text-muted" dir="ltr">
                    {leg.from} → {leg.to}
                  </span>
                  {leg.status !== 'open' && <Badge tone="neutral">{t('legCancelled')}</Badge>}
                </Td>
                {leg.cells.map((cell) => (
                  <Td key={cell.categoryId} className="whitespace-nowrap">
                    <span
                      className={cx(
                        'text-base font-semibold tabular-nums',
                        cell.free === 0 ? 'text-bad' : cell.free <= 2 ? 'text-warn' : 'text-ok',
                      )}
                    >
                      {cell.free}
                    </span>
                    <span className="text-xs text-muted"> / {cell.pool.total}</span>
                    <span className="block text-xs text-muted">
                      {cell.pool.booked > 0 && `${t('booked')} ${cell.pool.booked} `}
                      {cell.pool.held > 0 && `${t('held')} ${cell.pool.held} `}
                      {cell.allotted.total > 0 && `${t('allotted')} ${cell.allotted.total} `}
                      {cell.blocked > 0 && `${t('blocked')} ${cell.blocked}`}
                    </span>
                    {cell.pool.stopSale && <Badge tone="bad">{t('stopped')}</Badge>}
                    {cell.pool.overcommit > 0 && (
                      <Badge tone="bad">{t('overcommit', { n: cell.pool.overcommit })}</Badge>
                    )}
                  </Td>
                ))}
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {canWrite && selected.size > 0 && (
        <div className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3 shadow-lg">
          <span className="text-sm font-medium">{t('selected', { n: selected.size })}</span>
          <Button onClick={() => setAction('block')}>{t('block')}</Button>
          <Button variant="secondary" onClick={() => setAction('stop')}>
            {t('stopSale')}
          </Button>
          <Button variant="secondary" onClick={() => setAction('resume')}>
            {t('resumeSale')}
          </Button>
          <Button variant="danger" onClick={() => setAction('emergency')}>
            {t('emergency')}
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            {t('clear')}
          </Button>
        </div>
      )}

      <Card title={t('blocks')}>
        {release.isError && <Alert tone="bad">{errorText(release.error)}</Alert>}
        {!grid.data?.blocks.length ? (
          <p className="text-sm text-muted">{t('noBlocks')}</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {grid.data.blocks.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <Badge tone={b.kind === 'emergency' ? 'bad' : 'warn'}>
                    {b.kind === 'emergency' ? t('emergencyKind') : t('normal')}
                  </Badge>{' '}
                  {categoryCode(b.categoryId)} × {b.count} · {formatDate(b.firstDate, locale)}
                  {b.lastDate !== b.firstDate && ` – ${formatDate(b.lastDate, locale)}`} ·{' '}
                  {t('legs', { n: b.legs })}
                  <span className="block text-xs text-muted">{b.reason}</span>
                </span>
                {canWrite && (
                  <Button
                    variant="secondary"
                    disabled={release.isPending}
                    onClick={() => release.mutate({ blockId: b.id })}
                  >
                    {t('release')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {vessel && <CapacityCard vesselId={vessel.id} categories={categories} canWrite={canWrite} />}

      <ActionDialog
        action={action}
        legIds={[...selected]}
        categories={categories}
        onClose={() => setAction(null)}
        onDone={() => {
          setAction(null);
          setSelected(new Set());
          setNotice(t('done'));
          void refresh();
        }}
      />
    </div>
  );
}

function ActionDialog({
  action,
  legIds,
  categories,
  onClose,
  onDone,
}: {
  action: Action | null;
  legIds: string[];
  categories: Category[];
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const errorText = useErrorText();
  const [categoryId, setCategoryId] = useState('');
  const [count, setCount] = useState(1);
  const [reason, setReason] = useState('');
  const options = { onSuccess: onDone };
  const block = useMutation(trpc.inventory.block.mutationOptions(options));
  const emergency = useMutation(trpc.inventory.emergencyBlock.mutationOptions(options));
  const stopSale = useMutation(trpc.inventory.stopSale.mutationOptions(options));
  const running = [block, emergency, stopSale].find((m) => m.isPending || m.isError);
  const isBlock = action === 'block' || action === 'emergency';
  const category = categoryId || (isBlock ? (categories[0]?.id ?? '') : '');
  const title =
    action === 'block'
      ? t('block')
      : action === 'emergency'
        ? t('emergency')
        : action === 'stop'
          ? t('stopSale')
          : t('resumeSale');
  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (isBlock) {
            const input = { legIds, categoryId: category, count, reason: reason.trim() };
            if (action === 'block') block.mutate(input);
            else emergency.mutate(input);
          } else {
            stopSale.mutate({
              legIds,
              categoryIds: category ? [category] : undefined,
              stop: action === 'stop',
              reason: reason.trim(),
            });
          }
        }}
      >
        <p className="text-sm text-muted">{t('selected', { n: legIds.length })}</p>
        {action === 'emergency' && <Alert tone="warn">{t('emergencyHelp')}</Alert>}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('category')}>
            <Select value={category} onChange={(e) => setCategoryId(e.target.value)}>
              {!isBlock && <option value="">{t('allCategories')}</option>}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </Select>
          </Field>
          {isBlock && (
            <Field label={t('count')}>
              <Input
                type="number"
                min={1}
                max={500}
                value={count}
                onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
              />
            </Field>
          )}
        </div>
        <Field label={t('reason')}>
          <Input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {running?.isError && <Alert tone="bad">{errorText(running.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            variant={action === 'emergency' ? 'danger' : 'primary'}
            disabled={!reason.trim() || Boolean(running?.isPending)}
          >
            {tc('confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
