'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from './dialog';
import { Alert, Badge, Button, Card, Field, Input, Select, Table, Td } from './ui';
import { parseCabinNumbers } from '../lib/cabin-numbers';
import { cairoTodayIso } from '../lib/dates';
import { useErrorText } from '../lib/errors';
import { formatDate } from '../lib/format';
import { useTRPC } from '../lib/trpc';

interface Category {
  id: string;
  code: string;
}
type Change =
  | { kind: 'add' }
  | { kind: 'remove'; cabinId: string; number: string }
  | { kind: 'recategorise'; cabinId: string; number: string };

/** Physical cabins: add (one or many), take out of service or change category from a date on. */
export function CapacityCard({
  vesselId,
  categories,
  canWrite,
}: {
  vesselId: string;
  categories: Category[];
  canWrite: boolean;
}) {
  const t = useTranslations('inventory');
  const locale = useLocale();
  const trpc = useTRPC();
  const cabins = useQuery(trpc.schedule.cabins.queryOptions({ vesselId }));
  const [change, setChange] = useState<Change | null>(null);
  const code = (id: string | null) => categories.find((c) => c.id === id)?.code ?? '—';
  return (
    <Card
      title={t('capacity')}
      actions={
        canWrite && (
          <Button variant="secondary" onClick={() => setChange({ kind: 'add' })}>
            + {t('addCabins')}
          </Button>
        )
      }
    >
      {cabins.data?.length === 0 && <p className="text-sm text-muted">{t('noCabins')}</p>}
      <Table head={[t('cabin'), t('category'), t('deck'), '']}>
        {cabins.data?.map((c) => (
          <tr key={c.id}>
            <Td>
              <span dir="ltr">{c.number}</span> {c.accessible && <Badge tone="info">♿</Badge>}
            </Td>
            <Td>
              {code(c.categoryId)}
              {c.until && (
                <span className="block text-xs text-muted">
                  {t('until', { date: formatDate(c.until, locale) })}
                </span>
              )}
            </Td>
            <Td>{c.deck ?? '—'}</Td>
            <Td>
              {canWrite && c.categoryId && !c.until && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setChange({ kind: 'recategorise', cabinId: c.id, number: c.number })
                    }
                  >
                    {t('recategorise')}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setChange({ kind: 'remove', cabinId: c.id, number: c.number })}
                  >
                    {t('removeCabin')}
                  </Button>
                </div>
              )}
            </Td>
          </tr>
        ))}
      </Table>
      <CapacityDialog
        vesselId={vesselId}
        change={change}
        categories={categories}
        onClose={() => setChange(null)}
      />
    </Card>
  );
}

function CapacityDialog({
  vesselId,
  change,
  categories,
  onClose,
}: {
  vesselId: string;
  change: Change | null;
  categories: Category[];
  onClose: () => void;
}) {
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [effectiveFrom, setEffectiveFrom] = useState(() => cairoTodayIso());
  const [numbers, setNumbers] = useState('');
  const [accessible, setAccessible] = useState(false);
  const [deck, setDeck] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const done = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.schedule.cabins.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.inventory.grid.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.fleet.list.queryKey() });
      setNumbers('');
      onClose();
    },
  };
  const mutation = useMutation(trpc.schedule.capacity.mutationOptions(done));
  const addMany = useMutation(trpc.fleet.addCabins.mutationOptions(done));
  if (!change) return null;
  const parsed = parseCabinNumbers(numbers);
  const failed = mutation.error ?? addMany.error;
  const taken = (failed as { data?: { domainDetails?: { reason?: string; numbers?: string[] } } })
    ?.data?.domainDetails;
  const title =
    change.kind === 'add'
      ? t('addCabins')
      : `${change.kind === 'remove' ? t('removeCabin') : t('recategorise')} · ${change.number}`;
  return (
    <Dialog open onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (change.kind === 'add') {
            if ('numbers' in parsed)
              addMany.mutate({
                vesselId,
                categoryId,
                numbers: parsed.numbers,
                deck: deck.trim() || undefined,
                accessible,
                effectiveFrom,
                reason: reason.trim(),
              });
            return;
          }
          mutation.mutate({
            vesselId,
            effectiveFrom,
            reason: reason.trim(),
            change:
              change.kind === 'remove'
                ? { kind: 'remove', cabinId: change.cabinId }
                : { kind: 'recategorise', cabinId: change.cabinId, categoryId },
          });
        }}
      >
        {change.kind === 'add' && (
          <>
            <Field
              label={t('numbers')}
              hint={t('numbersHint')}
              error={
                numbers.trim() && 'error' in parsed
                  ? t(`numbersError.${parsed.error}`, { part: parsed.part ?? '' })
                  : undefined
              }
            >
              <Input
                required
                dir="ltr"
                value={numbers}
                placeholder="101-120, 201"
                onChange={(e) => setNumbers(e.target.value)}
              />
            </Field>
            {'numbers' in parsed && (
              <p className="text-sm text-muted">
                {t('numbersCount', { n: parsed.numbers.length })}
              </p>
            )}
            <div className="grid grid-cols-2 items-end gap-3">
              <Field label={t('deck')}>
                <Input value={deck} onChange={(e) => setDeck(e.target.value)} />
              </Field>
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={accessible}
                  onChange={(e) => setAccessible(e.target.checked)}
                />
                {t('accessible')}
              </label>
            </div>
          </>
        )}
        {change.kind !== 'remove' && (
          <Field label={t('category')}>
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('effectiveFrom')}>
          <Input
            type="date"
            required
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
          />
        </Field>
        <Field label={t('reason')}>
          <Input
            required
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
        {failed && (
          <Alert tone="bad">
            {taken?.reason === 'number_taken'
              ? t('numbersTaken', { numbers: (taken.numbers ?? []).join(', ') })
              : errorText(failed)}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={
              !reason.trim() ||
              mutation.isPending ||
              addMany.isPending ||
              (change.kind === 'add' && !('numbers' in parsed))
            }
          >
            {tc('confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
