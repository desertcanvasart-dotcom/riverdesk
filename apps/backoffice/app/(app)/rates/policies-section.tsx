'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Button, Card, Field, Input, Select } from '../../../components/ui';
import { formatMoney, minorToInput, parseMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { bpsToPercent, CURRENCIES, percentToBps, usePolicyError } from './policy-errors';

type Kind = 'child' | 'cancellation' | 'payment';
type Basis = 'free' | 'percent_of_adult' | 'fixed' | 'included';
type ChangeKind = 'any' | 'date' | 'category' | 'occupancy' | 'cabins' | 'guests';
const BASES: Basis[] = ['free', 'percent_of_adult', 'fixed', 'included'];
const CHANGE_KINDS: ChangeKind[] = ['any', 'date', 'category', 'occupancy', 'cabins', 'guests'];

interface ChildPolicy {
  id: string;
  name: string;
  adultFromAge: number;
  maxChildrenPerCabin: number;
  plans: number;
  bands: {
    ageFrom: number;
    ageTo: number;
    basis: Basis;
    percentBps: number | null;
    fixedAmount: string | null;
    fixedCurrency: string | null;
    requiresTwoAdults: boolean;
  }[];
}
interface CancellationPolicy {
  id: string;
  name: string;
  plans: number;
  rules: { fromDays: number; penaltyBps: number }[];
  fees: {
    changeKind: ChangeKind;
    fromDays: number;
    feeKind: 'flat' | 'percent';
    amount: string | null;
    currency: string | null;
    percentBps: number | null;
  }[];
}
interface PaymentPolicy {
  id: string;
  name: string;
  plans: number;
  depositBps: number;
  balanceDueDays: number;
  bankTransferHoldHours: number;
  cardHoldMinutes: number;
  autoCancelOverdue: boolean;
  autoCancelAfterDays: number | null;
}

/** The company's child, cancellation and payment policies: rate plans choose from them. */
export function PoliciesSection({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('policies');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const policyError = usePolicyError();
  const data = useQuery(trpc.rates.policies.queryOptions());
  const [open, setOpen] = useState<
    | { kind: 'child'; policy?: ChildPolicy }
    | { kind: 'cancellation'; policy?: CancellationPolicy }
    | { kind: 'payment'; policy?: PaymentPolicy }
    | null
  >(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.rates.policies.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.rates.setup.queryKey() });
  };
  const remove = useMutation(trpc.rates.deletePolicy.mutationOptions({ onSuccess: refresh }));
  const money = (amount: string | null, currency: string | null) =>
    amount && currency ? formatMoney(BigInt(amount), currency, locale) : '';

  const actions = (
    kind: Kind,
    policy: { id: string; name: string; plans: number },
    edit: () => void,
  ) =>
    canWrite && (
      <div className="flex shrink-0 gap-1">
        <Button variant="ghost" onClick={edit}>
          {t('edit')}
        </Button>
        {policy.plans === 0 && (
          <Button
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (window.confirm(t('deletePolicyConfirm', { name: policy.name })))
                remove.mutate({ kind, policyId: policy.id });
            }}
          >
            {t('delete')}
          </Button>
        )}
      </div>
    );
  const header = (policy: { name: string; plans: number }) => (
    <p className="font-medium">
      {policy.name}{' '}
      <span className="text-xs font-normal text-muted">
        · {policy.plans > 0 ? t('usedBy', { n: policy.plans }) : t('unused')}
      </span>
    </p>
  );
  const addButton = (kind: Kind) =>
    canWrite && (
      <Button variant="secondary" onClick={() => setOpen({ kind } as never)}>
        + {t('add')}
      </Button>
    );

  return (
    <>
      <p className="text-sm text-muted">{t('intro')}</p>
      {remove.isError && <Alert tone="bad">{policyError(remove.error)}</Alert>}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={t('cancellation')} actions={addButton('cancellation')}>
          {(data.data?.cancellation ?? []).map((p) => (
            <PolicyRow
              key={p.id}
              actions={actions('cancellation', p, () =>
                setOpen({ kind: 'cancellation', policy: p }),
              )}
            >
              {header(p)}
              <ul className="text-muted">
                {p.rules.map((r, i) => (
                  <li key={r.fromDays}>
                    {r.fromDays > 0
                      ? t('ruleLine', { n: r.fromDays, p: bpsToPercent(r.penaltyBps) })
                      : i > 0
                        ? t('ruleLast', {
                            n: p.rules[i - 1]!.fromDays,
                            p: bpsToPercent(r.penaltyBps),
                          })
                        : t('ruleAlways', { p: bpsToPercent(r.penaltyBps) })}
                  </li>
                ))}
                {p.fees.map((f, i) => (
                  <li key={i}>
                    {t('feeLine', {
                      kind: t(`change.${f.changeKind}`),
                      fee:
                        f.feeKind === 'flat'
                          ? money(f.amount, f.currency)
                          : `${bpsToPercent(f.percentBps ?? 0)}%`,
                      n: f.fromDays,
                    })}
                  </li>
                ))}
              </ul>
            </PolicyRow>
          ))}
        </Card>
        <Card title={t('children')} actions={addButton('child')}>
          {(data.data?.children ?? []).map((p) => (
            <PolicyRow
              key={p.id}
              actions={actions('child', p, () => setOpen({ kind: 'child', policy: p }))}
            >
              {header(p)}
              <ul className="text-muted">
                {p.bands.map((b) => (
                  <li key={b.ageFrom}>
                    {b.ageFrom === b.ageTo
                      ? t('bandOne', { n: b.ageFrom })
                      : t('bandLine', { from: b.ageFrom, to: b.ageTo })}
                    :{' '}
                    {b.basis === 'percent_of_adult'
                      ? t('percentOfAdult', { p: bpsToPercent(b.percentBps ?? 0) })
                      : b.basis === 'fixed'
                        ? money(b.fixedAmount, b.fixedCurrency)
                        : t(`basis.${b.basis}`)}
                    {b.requiresTwoAdults && ` (${t('twoAdults')})`}
                  </li>
                ))}
                <li>{t('adultsFrom', { n: p.adultFromAge, max: p.maxChildrenPerCabin })}</li>
              </ul>
            </PolicyRow>
          ))}
        </Card>
        <Card title={t('payment')} actions={addButton('payment')}>
          {(data.data?.payment ?? []).map((p) => (
            <PolicyRow
              key={p.id}
              actions={actions('payment', p, () => setOpen({ kind: 'payment', policy: p }))}
            >
              {header(p)}
              <ul className="text-muted">
                <li>{t('depositLine', { p: bpsToPercent(p.depositBps), n: p.balanceDueDays })}</li>
                <li>{t('holdLine', { h: p.bankTransferHoldHours, m: p.cardHoldMinutes })}</li>
                {p.autoCancelOverdue && (
                  <li>{t('autoCancelLine', { n: p.autoCancelAfterDays ?? 0 })}</li>
                )}
              </ul>
            </PolicyRow>
          ))}
        </Card>
      </div>
      {open?.kind === 'child' && (
        <ChildDialog
          key={open.policy?.id ?? 'add'}
          policy={open.policy}
          onClose={() => setOpen(null)}
          onDone={refresh}
        />
      )}
      {open?.kind === 'cancellation' && (
        <CancellationDialog
          key={open.policy?.id ?? 'add'}
          policy={open.policy}
          onClose={() => setOpen(null)}
          onDone={refresh}
        />
      )}
      {open?.kind === 'payment' && (
        <PaymentDialog
          key={open.policy?.id ?? 'add'}
          policy={open.policy}
          onClose={() => setOpen(null)}
          onDone={refresh}
        />
      )}
    </>
  );
}

function PolicyRow({ actions, children }: { actions: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-2 border-b border-line pb-3 text-sm last:mb-0 last:border-0 last:pb-0">
      <div className="min-w-0">{children}</div>
      {actions}
    </div>
  );
}

/** The form's buttons and error line, shared by the three dialogs. */
function Footer({ error, busy, onClose }: { error: unknown; busy: boolean; onClose: () => void }) {
  const tc = useTranslations('common');
  const policyError = usePolicyError();
  return (
    <>
      {Boolean(error) && <Alert tone="bad">{policyError(error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onClose}>
          {tc('close')}
        </Button>
        <Button type="submit" disabled={busy}>
          {tc('save')}
        </Button>
      </div>
    </>
  );
}

interface BandForm {
  ageTo: string;
  basis: Basis;
  percent: string;
  amount: string;
  currency: string;
  requiresTwoAdults: boolean;
}

function ChildDialog({
  policy,
  onClose,
  onDone,
}: {
  policy?: ChildPolicy;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('policies');
  const trpc = useTRPC();
  const [name, setName] = useState(policy?.name ?? '');
  const [adultFrom, setAdultFrom] = useState(String(policy?.adultFromAge ?? 12));
  const [maxChildren, setMaxChildren] = useState(String(policy?.maxChildrenPerCabin ?? 2));
  const [bands, setBands] = useState<BandForm[]>(
    policy?.bands.map((b) => ({
      ageTo: String(b.ageTo),
      basis: b.basis,
      percent: b.percentBps !== null ? bpsToPercent(b.percentBps) : '',
      amount: b.fixedAmount ? minorToInput(BigInt(b.fixedAmount), b.fixedCurrency ?? 'EGP') : '',
      currency: b.fixedCurrency ?? 'EGP',
      requiresTwoAdults: b.requiresTwoAdults,
    })) ?? [
      {
        ageTo: '1',
        basis: 'free',
        percent: '',
        amount: '',
        currency: 'EGP',
        requiresTwoAdults: false,
      },
      {
        ageTo: '11',
        basis: 'percent_of_adult',
        percent: '50',
        amount: '',
        currency: 'EGP',
        requiresTwoAdults: false,
      },
    ],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const add = useMutation(trpc.rates.addChildPolicy.mutationOptions());
  const update = useMutation(trpc.rates.updateChildPolicy.mutationOptions());
  const set = (i: number, patch: Partial<BandForm>) =>
    setBands((list) => list.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  // Each band starts where the one before ends: only the last age of each is typed.
  const from = (i: number) => (i === 0 ? 0 : Number(bands[i - 1]!.ageTo) + 1);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={policy ? `${t('editChild')} · ${policy.name}` : t('addChild')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const payload = [];
          for (const [i, b] of bands.entries()) {
            const percentBps = b.basis === 'percent_of_adult' ? percentToBps(b.percent) : undefined;
            const amount = b.basis === 'fixed' ? parseMoney(b.amount, b.currency) : undefined;
            if (percentBps === null || amount === null)
              return setFormError(t('errors.bandValue', { n: i + 1 }));
            payload.push({
              ageFrom: from(i),
              ageTo: Number(b.ageTo),
              basis: b.basis,
              percentBps,
              fixedAmount: amount,
              fixedCurrency: b.basis === 'fixed' ? b.currency : undefined,
              requiresTwoAdults: b.requiresTwoAdults,
            });
          }
          setFormError(null);
          const fields = {
            name: name.trim(),
            adultFromAge: Number(adultFrom),
            maxChildrenPerCabin: Number(maxChildren),
            bands: payload,
          };
          try {
            if (policy) await update.mutateAsync({ policyId: policy.id, ...fields });
            else await add.mutateAsync(fields);
            onDone();
            onClose();
          } catch {
            // Shown below.
          }
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <Field label={t('policyName')}>
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('adultFromAge')} hint={t('adultFromAgeHint')}>
            <Input
              type="number"
              min={1}
              max={18}
              required
              value={adultFrom}
              onChange={(e) => setAdultFrom(e.target.value)}
            />
          </Field>
          <Field label={t('maxChildren')}>
            <Input
              type="number"
              min={0}
              max={6}
              required
              value={maxChildren}
              onChange={(e) => setMaxChildren(e.target.value)}
            />
          </Field>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('bands')}</legend>
          {bands.map((b, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg bg-line/20 p-2">
              <Field label={t('ages')}>
                <div className="flex items-center gap-1">
                  <span className="min-w-6 text-center tabular-nums">{from(i)}</span>–
                  <Input
                    type="number"
                    className="w-20"
                    min={from(i)}
                    max={17}
                    required
                    value={b.ageTo}
                    onChange={(e) => set(i, { ageTo: e.target.value })}
                  />
                </div>
              </Field>
              <Field label={t('price')}>
                <Select
                  value={b.basis}
                  onChange={(e) => set(i, { basis: e.target.value as Basis })}
                >
                  {BASES.map((basis) => (
                    <option key={basis} value={basis}>
                      {t(`basis.${basis}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              {b.basis === 'percent_of_adult' && (
                <Field label={t('percentLabel')}>
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    className="w-24"
                    required
                    value={b.percent}
                    onChange={(e) => set(i, { percent: e.target.value })}
                  />
                </Field>
              )}
              {b.basis === 'fixed' && (
                <>
                  <Field label={t('amount')}>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      className="w-28"
                      required
                      value={b.amount}
                      onChange={(e) => set(i, { amount: e.target.value })}
                    />
                  </Field>
                  <Field label={t('currency')}>
                    <Select
                      value={b.currency}
                      onChange={(e) => set(i, { currency: e.target.value })}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
              <label className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={b.requiresTwoAdults}
                  onChange={(e) => set(i, { requiresTwoAdults: e.target.checked })}
                />
                {t('twoAdults')}
              </label>
              {bands.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setBands((list) => list.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setBands((list) => [
                  ...list,
                  {
                    ageTo: String(Number(adultFrom) - 1),
                    basis: 'percent_of_adult',
                    percent: '',
                    amount: '',
                    currency: 'EGP',
                    requiresTwoAdults: false,
                  },
                ])
              }
            >
              + {t('addBand')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('bandsHelp', { n: Number(adultFrom) - 1 })}</p>
        </fieldset>
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Footer
          error={add.error ?? update.error}
          busy={add.isPending || update.isPending}
          onClose={onClose}
        />
      </form>
    </Dialog>
  );
}

interface FeeForm {
  changeKind: ChangeKind;
  fromDays: string;
  feeKind: 'flat' | 'percent';
  amount: string;
  currency: string;
  percent: string;
}

function CancellationDialog({
  policy,
  onClose,
  onDone,
}: {
  policy?: CancellationPolicy;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('policies');
  const trpc = useTRPC();
  const [name, setName] = useState(policy?.name ?? '');
  const [rules, setRules] = useState(
    policy?.rules.map((r) => ({
      fromDays: String(r.fromDays),
      percent: bpsToPercent(r.penaltyBps),
    })) ?? [
      { fromDays: '60', percent: '0' },
      { fromDays: '30', percent: '25' },
      { fromDays: '0', percent: '100' },
    ],
  );
  const [fees, setFees] = useState<FeeForm[]>(
    policy?.fees.map((f) => ({
      changeKind: f.changeKind,
      fromDays: String(f.fromDays),
      feeKind: f.feeKind,
      amount: f.amount ? minorToInput(BigInt(f.amount), f.currency ?? 'EGP') : '',
      currency: f.currency ?? 'EGP',
      percent: f.percentBps !== null ? bpsToPercent(f.percentBps) : '',
    })) ?? [],
  );
  const [formError, setFormError] = useState<string | null>(null);
  const add = useMutation(trpc.rates.addCancellationPolicy.mutationOptions());
  const update = useMutation(trpc.rates.updateCancellationPolicy.mutationOptions());
  const setRule = (i: number, patch: Partial<{ fromDays: string; percent: string }>) =>
    setRules((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setFee = (i: number, patch: Partial<FeeForm>) =>
    setFees((list) => list.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={policy ? `${t('editCancellation')} · ${policy.name}` : t('addCancellation')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const payloadRules = [];
          for (const r of rules) {
            const penaltyBps = percentToBps(r.percent);
            if (penaltyBps === null) return setFormError(t('errors.percentValue'));
            payloadRules.push({ fromDays: Number(r.fromDays), penaltyBps });
          }
          const payloadFees = [];
          for (const f of fees) {
            const percentBps = f.feeKind === 'percent' ? percentToBps(f.percent) : undefined;
            const amount = f.feeKind === 'flat' ? parseMoney(f.amount, f.currency) : undefined;
            if (percentBps === null || amount === null) return setFormError(t('errors.feeValue'));
            payloadFees.push({
              changeKind: f.changeKind,
              fromDays: Number(f.fromDays),
              feeKind: f.feeKind,
              amount,
              currency: f.feeKind === 'flat' ? f.currency : undefined,
              percentBps,
            });
          }
          setFormError(null);
          const fields = { name: name.trim(), rules: payloadRules, amendmentFees: payloadFees };
          try {
            if (policy) await update.mutateAsync({ policyId: policy.id, ...fields });
            else await add.mutateAsync(fields);
            onDone();
            onClose();
          } catch {
            // Shown below.
          }
        }}
      >
        <Field label={t('policyName')}>
          <Input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('penalties')}</legend>
          {rules.map((r, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field label={t('fromDays')}>
                <Input
                  type="number"
                  className="w-24"
                  min={0}
                  required
                  value={r.fromDays}
                  onChange={(e) => setRule(i, { fromDays: e.target.value })}
                />
              </Field>
              <Field label={t('penaltyPercent')}>
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  className="w-24"
                  required
                  value={r.percent}
                  onChange={(e) => setRule(i, { percent: e.target.value })}
                />
              </Field>
              {rules.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRules((list) => list.filter((_, j) => j !== i))}
                >
                  ×
                </Button>
              )}
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRules((list) => [...list, { fromDays: '', percent: '' }])}
            >
              + {t('addPenalty')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('penaltiesHelp')}</p>
        </fieldset>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('amendmentFees')}</legend>
          {fees.map((f, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2 rounded-lg bg-line/20 p-2">
              <Field label={t('changeKind')}>
                <Select
                  value={f.changeKind}
                  onChange={(e) => setFee(i, { changeKind: e.target.value as ChangeKind })}
                >
                  {CHANGE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {t(`change.${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('fromDays')}>
                <Input
                  type="number"
                  className="w-24"
                  min={0}
                  required
                  value={f.fromDays}
                  onChange={(e) => setFee(i, { fromDays: e.target.value })}
                />
              </Field>
              <Field label={t('feeKind')}>
                <Select
                  value={f.feeKind}
                  onChange={(e) => setFee(i, { feeKind: e.target.value as 'flat' | 'percent' })}
                >
                  <option value="flat">{t('flat')}</option>
                  <option value="percent">{t('percentOfBooking')}</option>
                </Select>
              </Field>
              {f.feeKind === 'flat' ? (
                <>
                  <Field label={t('amount')}>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      className="w-28"
                      required
                      value={f.amount}
                      onChange={(e) => setFee(i, { amount: e.target.value })}
                    />
                  </Field>
                  <Field label={t('currency')}>
                    <Select
                      value={f.currency}
                      onChange={(e) => setFee(i, { currency: e.target.value })}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </Select>
                  </Field>
                </>
              ) : (
                <Field label={t('percentLabel')}>
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    className="w-24"
                    required
                    value={f.percent}
                    onChange={(e) => setFee(i, { percent: e.target.value })}
                  />
                </Field>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setFees((list) => list.filter((_, j) => j !== i))}
              >
                ×
              </Button>
            </div>
          ))}
          <div>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                setFees((list) => [
                  ...list,
                  {
                    changeKind: 'any',
                    fromDays: '0',
                    feeKind: 'flat',
                    amount: '',
                    currency: 'EGP',
                    percent: '',
                  },
                ])
              }
            >
              + {t('addFee')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('feesHelp')}</p>
        </fieldset>
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Footer
          error={add.error ?? update.error}
          busy={add.isPending || update.isPending}
          onClose={onClose}
        />
      </form>
    </Dialog>
  );
}

function PaymentDialog({
  policy,
  onClose,
  onDone,
}: {
  policy?: PaymentPolicy;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('policies');
  const trpc = useTRPC();
  const [autoCancel, setAutoCancel] = useState(policy?.autoCancelOverdue ?? false);
  const [formError, setFormError] = useState<string | null>(null);
  const add = useMutation(trpc.rates.addPaymentPolicy.mutationOptions());
  const update = useMutation(trpc.rates.updatePaymentPolicy.mutationOptions());
  return (
    <Dialog
      open
      onClose={onClose}
      title={policy ? `${t('editPayment')} · ${policy.name}` : t('addPayment')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const depositBps = percentToBps(String(form.get('deposit')));
          if (depositBps === null) return setFormError(t('errors.percentValue'));
          setFormError(null);
          const fields = {
            name: String(form.get('name')).trim(),
            depositBps,
            balanceDueDays: Number(form.get('balanceDueDays')),
            bankTransferHoldHours: Number(form.get('bankHours')),
            cardHoldMinutes: Number(form.get('cardMinutes')),
            autoCancelOverdue: autoCancel,
            autoCancelAfterDays: autoCancel ? Number(form.get('autoCancelDays')) : undefined,
          };
          try {
            if (policy) await update.mutateAsync({ policyId: policy.id, ...fields });
            else await add.mutateAsync(fields);
            onDone();
            onClose();
          } catch {
            // Shown below.
          }
        }}
      >
        <Field label={t('policyName')}>
          <Input name="name" required maxLength={100} defaultValue={policy?.name} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('depositPercent')}>
            <Input
              name="deposit"
              dir="ltr"
              inputMode="decimal"
              required
              defaultValue={bpsToPercent(policy?.depositBps ?? 2500)}
            />
          </Field>
          <Field label={t('balanceDueDays')} hint={t('balanceDueDaysHint')}>
            <Input
              name="balanceDueDays"
              type="number"
              min={0}
              required
              defaultValue={policy?.balanceDueDays ?? 30}
            />
          </Field>
          <Field label={t('bankHours')} hint={t('bankHoursHint')}>
            <Input
              name="bankHours"
              type="number"
              min={1}
              required
              defaultValue={policy?.bankTransferHoldHours ?? 24}
            />
          </Field>
          <Field label={t('cardMinutes')} hint={t('cardMinutesHint')}>
            <Input
              name="cardMinutes"
              type="number"
              min={1}
              required
              defaultValue={policy?.cardHoldMinutes ?? 30}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={autoCancel}
            onChange={(e) => setAutoCancel(e.target.checked)}
          />
          {t('autoCancel')}
        </label>
        {autoCancel && (
          <Field label={t('autoCancelDays')} hint={t('autoCancelDaysHint')}>
            <Input
              name="autoCancelDays"
              type="number"
              min={0}
              required
              defaultValue={policy?.autoCancelAfterDays ?? 7}
            />
          </Field>
        )}
        {formError && <Alert tone="bad">{formError}</Alert>}
        <Footer
          error={add.error ?? update.error}
          busy={add.isPending || update.isPending}
          onClose={onClose}
        />
      </form>
    </Dialog>
  );
}
