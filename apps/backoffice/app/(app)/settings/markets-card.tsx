'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
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
import { COMMON_MARKETS, usePickName } from '../../../lib/choices';
import { useErrorText } from '../../../lib/errors';
import { useMarkets } from '../../../lib/markets';
import { useTRPC } from '../../../lib/trpc';

interface Market {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  needsResidencyProof: boolean;
  active: boolean;
  sortOrder: number;
  plans: number;
}

/** Markets: who a price is for. Rate plans pick one; vouchers show the residency line. */
export function MarketsCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('markets');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { markets } = useMarkets();
  const [editing, setEditing] = useState<Market | 'add' | null>(null);
  const errorText = useMarketError();
  const remove = useMutation(
    trpc.settings.deleteMarket.mutationOptions({
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: trpc.settings.markets.queryKey() }),
    }),
  );
  return (
    <Card
      title={t('title')}
      actions={
        canWrite && (
          <Button variant="secondary" onClick={() => setEditing('add')}>
            + {t('add')}
          </Button>
        )
      }
    >
      <p className="mb-3 text-sm text-muted">{t('intro')}</p>
      {remove.isError && (
        <div className="mb-3">
          <Alert tone="bad">{errorText(remove.error)}</Alert>
        </div>
      )}
      <Table head={[t('name'), t('code'), t('proof'), t('plans'), '']}>
        {markets.map((m) => (
          <tr key={m.id} className={m.active ? '' : 'opacity-60'}>
            <Td>
              {locale.startsWith('ar') ? m.nameAr : m.nameEn}
              {!m.active && (
                <span className="ms-2">
                  <Badge>{t('off')}</Badge>
                </span>
              )}
            </Td>
            <Td>
              <span dir="ltr">{m.code}</span>
            </Td>
            <Td>{m.needsResidencyProof ? <Badge tone="info">{t('proofYes')}</Badge> : '—'}</Td>
            <Td>{m.plans}</Td>
            <Td>
              {canWrite && (
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setEditing(m)}>
                    {t('editRow')}
                  </Button>
                  {m.plans === 0 && (
                    <Button
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(t('deleteConfirm', { name: m.nameEn })))
                          remove.mutate({ marketId: m.id });
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
      {editing && (
        <MarketDialog
          key={editing === 'add' ? 'add' : editing.id}
          market={editing === 'add' ? undefined : editing}
          nextSort={(markets.at(-1)?.sortOrder ?? 0) + 10}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function useMarketError() {
  const t = useTranslations('markets');
  const errorText = useErrorText();
  return (error: unknown) => {
    const reason = (error as { data?: { domainDetails?: { reason?: string } } } | null)?.data
      ?.domainDetails?.reason;
    return reason && t.has(`errors.${reason}`) ? t(`errors.${reason}`) : errorText(error);
  };
}

function MarketDialog({
  market,
  nextSort,
  onClose,
}: {
  market?: Market;
  nextSort: number;
  onClose: () => void;
}) {
  const t = useTranslations('markets');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useMarketError();
  const done = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.settings.markets.queryKey() });
      onClose();
    },
  };
  const add = useMutation(trpc.settings.addMarket.mutationOptions(done));
  const { markets } = useMarkets();
  const pickName = usePickName();
  const [preset, setPreset] = useState<(typeof COMMON_MARKETS)[number] | null>(null);
  const k = preset?.[0] ?? '';
  const update = useMutation(trpc.settings.updateMarket.mutationOptions(done));
  const failed = add.error ?? update.error;
  return (
    <Dialog open onClose={onClose} title={market ? `${t('edit')} · ${market.nameEn}` : t('add')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const fields = {
            nameEn: String(form.get('nameEn')).trim(),
            nameAr: String(form.get('nameAr')).trim(),
            needsResidencyProof: form.get('proof') === 'on',
            sortOrder: Number(form.get('sortOrder')),
          };
          if (market)
            update.mutate({ marketId: market.id, active: form.get('active') === 'on', ...fields });
          else add.mutate({ code: String(form.get('code')).trim().toLowerCase(), ...fields });
        }}
      >
        {!market && (
          <Field label={t('startFrom')}>
            <Select
              value={k}
              onChange={(e) =>
                setPreset(COMMON_MARKETS.find((x) => x[0] === e.target.value) ?? null)
              }
            >
              <option value="">{t('ownMarket')}</option>
              {COMMON_MARKETS.filter((x) => !markets.some((m) => m.code === x[0])).map((x) => (
                <option key={x[0]} value={x[0]}>
                  {pickName(x)}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('nameEn')}>
            <Input
              key={`en-${k}`}
              name="nameEn"
              required
              maxLength={100}
              dir="ltr"
              defaultValue={market?.nameEn ?? preset?.[1]}
            />
          </Field>
          <Field label={t('nameAr')}>
            <Input
              key={`ar-${k}`}
              name="nameAr"
              required
              maxLength={100}
              dir="rtl"
              defaultValue={market?.nameAr ?? preset?.[2]}
            />
          </Field>
          <Field label={t('code')} hint={market ? t('codeFixed') : t('codeHint')}>
            <Input
              name="code"
              required
              dir="ltr"
              className="lowercase"
              pattern="[A-Za-z][A-Za-z_]{1,31}"
              disabled={Boolean(market)}
              key={`code-${k}`}
              defaultValue={market?.code ?? preset?.[0]}
            />
          </Field>
          <Field label={t('order')}>
            <Input
              name="sortOrder"
              type="number"
              min={0}
              max={999}
              required
              defaultValue={market?.sortOrder ?? nextSort}
            />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            key={`proof-${k}`}
            type="checkbox"
            name="proof"
            className="mt-0.5 size-4"
            defaultChecked={market?.needsResidencyProof ?? preset?.[3] ?? true}
          />
          <span>
            {t('proofLabel')}
            <span className="block text-xs text-muted">{t('proofHint')}</span>
          </span>
        </label>
        {market && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="active"
              className="mt-0.5 size-4"
              defaultChecked={market.active}
            />
            <span>
              {t('active')}
              <span className="block text-xs text-muted">{t('activeHint')}</span>
            </span>
          </label>
        )}
        {failed && <Alert tone="bad">{errorText(failed)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={add.isPending || update.isPending}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
