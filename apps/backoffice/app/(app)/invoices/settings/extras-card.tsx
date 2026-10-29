'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../../components/dialog';
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
} from '../../../../components/ui';
import { useErrorText } from '../../../../lib/errors';
import { formatMoney, minorToInput, parseMoney } from '../../../../lib/format';
import { useTRPC } from '../../../../lib/trpc';

const CATEGORIES = [
  'bar',
  'minibar',
  'restaurant',
  'laundry',
  'spa',
  'excursion',
  'gratuity',
  'communication',
  'shop',
  'other',
] as const;
const CURRENCIES = ['USD', 'EUR', 'GBP', 'EGP'];

type Item = {
  id: string;
  vesselId: string | null;
  category: (typeof CATEGORIES)[number];
  nameAr: string;
  nameEn: string;
  price: bigint;
  currency: string;
  taxRateId: string | null;
  active: boolean;
  sortOrder: number;
};

/**
 * Extras on board (E1): which vessels keep folios and in which currency, and the price list the
 * on-board staff charge from. Charges keep the price they were posted with.
 */
export function ExtrasCard() {
  const t = useTranslations('folios');
  const locale = useLocale();
  const isArabic = locale.startsWith('ar');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const data = useQuery(trpc.folios.settings.queryOptions());
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: trpc.folios.settings.queryKey() });
  const vessel = useMutation(trpc.folios.updateVessel.mutationOptions({ onSuccess: refresh }));
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  if (!data.data) return null;
  const { vessels, items, taxRates } = data.data;
  const vesselName = (id: string | null) =>
    id ? (vessels.find((v) => v.id === id)?.name ?? '—') : t('allVessels');

  return (
    <Card
      title={t('settingsTitle')}
      actions={<Button onClick={() => setEditing('new')}>{t('addItem')}</Button>}
    >
      <p className="mb-3 text-sm text-muted">{t('settingsHint')}</p>
      {vessel.isError && (
        <div className="mb-3">
          <Alert tone="bad">{errorText(vessel.error)}</Alert>
        </div>
      )}
      <div className="mb-4 flex flex-col gap-2">
        {vessels.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="min-w-32 font-medium">{v.name}</span>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="size-4"
                checked={v.folioEnabled}
                disabled={vessel.isPending}
                onChange={(e) => vessel.mutate({ vesselId: v.id, folioEnabled: e.target.checked })}
              />
              {t('enabled')}
            </label>
            <label className="flex items-center gap-2">
              {t('currency')}
              <Select
                value={v.folioCurrency}
                disabled={vessel.isPending}
                onChange={(e) => vessel.mutate({ vesselId: v.id, folioCurrency: e.target.value })}
                className="w-24"
              >
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            </label>
          </div>
        ))}
      </div>
      {items.length === 0 ? (
        <Empty>{t('noItems')}</Empty>
      ) : (
        <Table head={[t('item'), t('category'), t('price'), t('vessel'), '', '']}>
          {(items as Item[]).map((x) => (
            <tr key={x.id}>
              <Td>{isArabic ? x.nameAr : x.nameEn}</Td>
              <Td>{t(`cat_${x.category}`)}</Td>
              <Td className="tabular-nums">{formatMoney(x.price, x.currency, locale)}</Td>
              <Td>{vesselName(x.vesselId)}</Td>
              <Td>{!x.active && <Badge>{t('inactive')}</Badge>}</Td>
              <Td>
                <Button variant="ghost" onClick={() => setEditing(x)}>
                  {t('edit')}
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {editing && (
        <ItemDialog
          item={editing === 'new' ? null : editing}
          vessels={vessels}
          taxRates={taxRates}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function ItemDialog({
  item,
  vessels,
  taxRates,
  onClose,
}: {
  item: Item | null;
  vessels: { id: string; name: string; folioCurrency: string }[];
  taxRates: { id: string; nameAr: string; nameEn: string; rateBps: number; active: boolean }[];
  onClose: () => void;
}) {
  const t = useTranslations('folios');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [form, setForm] = useState({
    nameAr: item?.nameAr ?? '',
    nameEn: item?.nameEn ?? '',
    category: item?.category ?? 'bar',
    vesselId: item?.vesselId ?? '',
    currency: item?.currency ?? vessels[0]?.folioCurrency ?? 'USD',
    price: item ? minorToInput(item.price, item.currency) : '',
    taxRateId: item?.taxRateId ?? '',
    active: item?.active ?? true,
  });
  const save = useMutation(
    trpc.folios.saveItem.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.folios.settings.queryKey() });
        onClose();
      },
    }),
  );
  const price = parseMoney(form.price, form.currency);
  const valid = form.nameAr.trim() && form.nameEn.trim() && price !== null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  return (
    <Dialog open onClose={onClose} title={item ? t('editItem') : t('addItem')}>
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('nameAr')}>
            <Input
              dir="rtl"
              value={form.nameAr}
              onChange={(e) => set({ nameAr: e.target.value })}
            />
          </Field>
          <Field label={t('nameEn')}>
            <Input
              dir="ltr"
              value={form.nameEn}
              onChange={(e) => set({ nameEn: e.target.value })}
            />
          </Field>
          <Field label={t('category')}>
            <Select
              value={form.category}
              onChange={(e) => set({ category: e.target.value as Item['category'] })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`cat_${c}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('vessel')}>
            <Select value={form.vesselId} onChange={(e) => set({ vesselId: e.target.value })}>
              <option value="">{t('allVessels')}</option>
              {vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('price')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={form.price}
              onChange={(e) => set({ price: e.target.value })}
            />
          </Field>
          <Field label={t('currency')}>
            <Select value={form.currency} onChange={(e) => set({ currency: e.target.value })}>
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('tax')}>
            <Select value={form.taxRateId} onChange={(e) => set({ taxRateId: e.target.value })}>
              <option value="">{t('noTax')}</option>
              {taxRates
                .filter((x) => x.active || x.id === form.taxRateId)
                .map((x) => (
                  <option key={x.id} value={x.id}>
                    {locale.startsWith('ar') ? x.nameAr : x.nameEn} ({x.rateBps / 100}%)
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          {t('activeLabel')}
        </label>
        {save.isError && <Alert tone="bad">{errorText(save.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button
            disabled={save.isPending || !valid}
            onClick={() =>
              save.mutate({
                ...(item ? { id: item.id, sortOrder: item.sortOrder } : {}),
                nameAr: form.nameAr.trim(),
                nameEn: form.nameEn.trim(),
                category: form.category,
                vesselId: form.vesselId || null,
                price: price!,
                currency: form.currency,
                taxRateId: form.taxRateId || null,
                active: form.active,
              })
            }
          >
            {tc('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
