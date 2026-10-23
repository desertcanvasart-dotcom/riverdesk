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
  Field,
  Input,
  Select,
  Table,
  Td,
} from '../../../components/ui';
import { cairoTodayIso } from '../../../lib/dates';
import { useErrorText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

interface Category {
  id: string;
  code: string;
}
type Change =
  | { kind: 'add' }
  | { kind: 'remove'; cabinId: string; number: string }
  | { kind: 'recategorise'; cabinId: string; number: string };

/** Physical cabins: add, take out of service or change category from a date on. */
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
            + {t('addCabin')}
          </Button>
        )
      }
    >
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
  const [number, setNumber] = useState('');
  const [deck, setDeck] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const mutation = useMutation(
    trpc.schedule.capacity.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.schedule.cabins.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.inventory.grid.queryKey() });
        onClose();
      },
    }),
  );
  if (!change) return null;
  const title =
    change.kind === 'add'
      ? t('addCabin')
      : `${change.kind === 'remove' ? t('removeCabin') : t('recategorise')} · ${change.number}`;
  return (
    <Dialog open onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({
            vesselId,
            effectiveFrom,
            reason: reason.trim(),
            change:
              change.kind === 'add'
                ? { kind: 'add', number: number.trim(), categoryId, deck: deck.trim() || undefined }
                : change.kind === 'remove'
                  ? { kind: 'remove', cabinId: change.cabinId }
                  : { kind: 'recategorise', cabinId: change.cabinId, categoryId },
          });
        }}
      >
        {change.kind === 'add' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('number')}>
              <Input
                required
                dir="ltr"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
              />
            </Field>
            <Field label={t('deck')}>
              <Input value={deck} onChange={(e) => setDeck(e.target.value)} />
            </Field>
          </div>
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
        {mutation.isError && <Alert tone="bad">{errorText(mutation.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={!reason.trim() || mutation.isPending}>
            {tc('confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
