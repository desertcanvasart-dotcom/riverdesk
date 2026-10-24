'use client';

import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Button, Field, Input, Select } from '../../../components/ui';
import { useTRPC } from '../../../lib/trpc';
import { useMarkets } from '../../../lib/markets';
import { CURRENCIES, usePolicyError } from './policy-errors';

export const BOARDS = ['full_board', 'half_board', 'bed_breakfast', 'all_inclusive'] as const;

export interface Plan {
  id: string;
  code: string;
  name: string;
  market: string;
  currency: string;
  board: string;
  pricingUnit: 'per_person' | 'per_cabin';
  pricingPeriod: 'per_night' | 'per_package';
  minNights: number;
  childPolicyId: string;
  cancellationPolicyId: string;
  paymentPolicyId: string;
  inclusions: { en?: string[]; ar?: string[] };
  exclusions: { en?: string[]; ar?: string[] };
  active: boolean;
  rates: number;
  used: number;
}

interface Contract {
  id: string;
  channel: string;
  channelType: string;
  ratePlanIds: string[];
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * A rate plan: who it is for (market, currency), how prices are counted, its policies and what
 * it includes. New plans can be sold in the back office at once; existing ones choose channels.
 */
export function PlanDialog({
  vesselId,
  plan,
  contracts,
  onClose,
  onDone,
}: {
  vesselId: string;
  plan?: Plan;
  contracts: Contract[];
  onClose: () => void;
  onDone: (planId: string) => void;
}) {
  const t = useTranslations('plans');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const policyError = usePolicyError();
  const policies = useQuery(trpc.rates.policies.queryOptions());
  const { markets, name: marketName } = useMarkets();
  const basicsFixed = Boolean(plan && plan.rates > 0);
  const [form, setForm] = useState({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    market: plan?.market ?? 'international',
    currency: plan?.currency ?? 'USD',
    board: plan?.board ?? 'full_board',
    pricingUnit: plan?.pricingUnit ?? ('per_person' as const),
    pricingPeriod: plan?.pricingPeriod ?? ('per_night' as const),
    minNights: String(plan?.minNights ?? 1),
    childPolicyId: plan?.childPolicyId ?? '',
    cancellationPolicyId: plan?.cancellationPolicyId ?? '',
    paymentPolicyId: plan?.paymentPolicyId ?? '',
    inclusionsEn: (plan?.inclusions.en ?? []).join('\n'),
    inclusionsAr: (plan?.inclusions.ar ?? []).join('\n'),
    exclusionsEn: (plan?.exclusions.en ?? []).join('\n'),
    exclusionsAr: (plan?.exclusions.ar ?? []).join('\n'),
    active: plan?.active ?? true,
    sellInBackOffice: true,
  });
  const [sold, setSold] = useState<Set<string>>(
    () =>
      new Set(contracts.filter((k) => plan && k.ratePlanIds.includes(plan.id)).map((k) => k.id)),
  );
  const add = useMutation(trpc.rates.addPlan.mutationOptions());
  const update = useMutation(trpc.rates.updatePlan.mutationOptions());
  const setContracts = useMutation(trpc.rates.setPlanContracts.mutationOptions());
  const failed = add.error ?? update.error ?? setContracts.error;
  const busy = add.isPending || update.isPending || setContracts.isPending;
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const pick = (list: { id: string }[] | undefined, current: string) =>
    current || list?.[0]?.id || '';
  const childPolicyId = pick(policies.data?.children, form.childPolicyId);
  const cancellationPolicyId = pick(policies.data?.cancellation, form.cancellationPolicyId);
  const paymentPolicyId = pick(policies.data?.payment, form.paymentPolicyId);
  const missingPolicies = !childPolicyId || !cancellationPolicyId || !paymentPolicyId;

  return (
    <Dialog open wide onClose={onClose} title={plan ? `${t('edit')} · ${plan.code}` : t('add')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const fields = {
            name: form.name.trim(),
            market: form.market,
            currency: form.currency,
            board: form.board,
            pricingUnit: form.pricingUnit,
            pricingPeriod: form.pricingPeriod,
            minNights: Number(form.minNights),
            childPolicyId,
            cancellationPolicyId,
            paymentPolicyId,
            inclusions: { en: lines(form.inclusionsEn), ar: lines(form.inclusionsAr) },
            exclusions: { en: lines(form.exclusionsEn), ar: lines(form.exclusionsAr) },
          };
          try {
            if (plan) {
              await update.mutateAsync({ ratePlanId: plan.id, active: form.active, ...fields });
              await setContracts.mutateAsync({ ratePlanId: plan.id, contractIds: [...sold] });
              onDone(plan.id);
            } else {
              const created = await add.mutateAsync({
                vesselId,
                code: form.code.trim().toUpperCase(),
                sellInBackOffice: form.sellInBackOffice,
                ...fields,
              });
              onDone(created.id);
            }
            onClose();
          } catch {
            // Shown below.
          }
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('name')} hint={t('nameHint')}>
            <Input
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label={t('code')} hint={plan ? t('codeFixed') : t('codeHint')}>
            <Input
              required
              dir="ltr"
              className="uppercase"
              pattern="[A-Za-z][A-Za-z0-9_\-]{0,23}"
              disabled={Boolean(plan)}
              value={form.code}
              onChange={(e) => set({ code: e.target.value })}
            />
          </Field>
          <Field label={t('market')}>
            <Select
              value={form.market}
              disabled={basicsFixed}
              onChange={(e) => set({ market: e.target.value })}
            >
              {markets
                .filter((m) => m.active || m.code === form.market)
                .map((m) => (
                  <option key={m.code} value={m.code}>
                    {marketName(m.code)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('currency')}>
            <Select
              value={form.currency}
              disabled={basicsFixed}
              onChange={(e) => set({ currency: e.target.value })}
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label={t('unit')}>
            <Select
              value={form.pricingUnit}
              disabled={basicsFixed}
              onChange={(e) => set({ pricingUnit: e.target.value as typeof form.pricingUnit })}
            >
              <option value="per_person">{t('perPerson')}</option>
              <option value="per_cabin">{t('perCabin')}</option>
            </Select>
          </Field>
          <Field label={t('period')}>
            <Select
              value={form.pricingPeriod}
              disabled={basicsFixed}
              onChange={(e) => set({ pricingPeriod: e.target.value as typeof form.pricingPeriod })}
            >
              <option value="per_night">{t('perNight')}</option>
              <option value="per_package">{t('perPackage')}</option>
            </Select>
          </Field>
        </div>
        {basicsFixed && <p className="text-xs text-muted">{t('basicsFixed')}</p>}
        <p className="text-xs text-muted">{t('unitHelp')}</p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('board')}>
            <Select value={form.board} onChange={(e) => set({ board: e.target.value })}>
              {BOARDS.map((b) => (
                <option key={b} value={b}>
                  {t(`boards.${b}`)}
                </option>
              ))}
              {!BOARDS.includes(form.board as never) && (
                <option value={form.board}>{form.board}</option>
              )}
            </Select>
          </Field>
          <Field label={t('minNights')}>
            <Input
              type="number"
              min={1}
              required
              value={form.minNights}
              onChange={(e) => set({ minNights: e.target.value })}
            />
          </Field>
          <div />
          <Field label={t('childPolicy')}>
            <Select value={childPolicyId} onChange={(e) => set({ childPolicyId: e.target.value })}>
              {policies.data?.children.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('cancellationPolicy')}>
            <Select
              value={cancellationPolicyId}
              onChange={(e) => set({ cancellationPolicyId: e.target.value })}
            >
              {policies.data?.cancellation.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('paymentPolicy')}>
            <Select
              value={paymentPolicyId}
              onChange={(e) => set({ paymentPolicyId: e.target.value })}
            >
              {policies.data?.payment.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {missingPolicies && policies.data && <Alert tone="warn">{t('policiesFirst')}</Alert>}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('inclusionsEn')} hint={t('linesHint')}>
            <textarea
              dir="ltr"
              rows={3}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              value={form.inclusionsEn}
              onChange={(e) => set({ inclusionsEn: e.target.value })}
            />
          </Field>
          <Field label={t('inclusionsAr')}>
            <textarea
              dir="rtl"
              rows={3}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              value={form.inclusionsAr}
              onChange={(e) => set({ inclusionsAr: e.target.value })}
            />
          </Field>
          <Field label={t('exclusionsEn')}>
            <textarea
              dir="ltr"
              rows={2}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              value={form.exclusionsEn}
              onChange={(e) => set({ exclusionsEn: e.target.value })}
            />
          </Field>
          <Field label={t('exclusionsAr')}>
            <textarea
              dir="rtl"
              rows={2}
              className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              value={form.exclusionsAr}
              onChange={(e) => set({ exclusionsAr: e.target.value })}
            />
          </Field>
        </div>

        {plan ? (
          <>
            <fieldset className="flex flex-col gap-1 text-sm">
              <legend className="mb-1 font-medium">{t('soldThrough')}</legend>
              {contracts.length === 0 && <p className="text-muted">{t('noContracts')}</p>}
              {contracts.map((k) => (
                <label key={k.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={sold.has(k.id)}
                    onChange={() => {
                      const next = new Set(sold);
                      if (next.has(k.id)) next.delete(k.id);
                      else next.add(k.id);
                      setSold(next);
                    }}
                  />
                  {k.channel}
                </label>
              ))}
            </fieldset>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={form.active}
                onChange={(e) => set({ active: e.target.checked })}
              />
              {t('active')}
            </label>
          </>
        ) : (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={form.sellInBackOffice}
              onChange={(e) => set({ sellInBackOffice: e.target.checked })}
            />
            {t('sellInBackOffice')}
          </label>
        )}
        {failed && <Alert tone="bad">{policyError(failed)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button type="submit" disabled={busy || missingPolicies}>
            {tc('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
