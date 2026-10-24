'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { VesselSelect } from '../../../components/range-nav';
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
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatMoney, minorToInput, parseMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { PlanDialog } from './plan-dialog';
import { PoliciesSection } from './policies-section';
import { usePolicyError } from './policy-errors';
import { SeasonsCard } from './seasons-card';

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

const BASES = ['single', 'double', 'triple'] as const;
const cell = (categoryId: string, basis: string | null) => `${categoryId}:${basis ?? '-'}`;

export function RatesScreen({ vessels, canWrite }: { vessels: Vessel[]; canWrite: boolean }) {
  const t = useTranslations('rates');
  const tc = useTranslations('common');
  const tb = useTranslations('basis');
  const tbook = useTranslations('book');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const vessel = vessels.find((v) => v.id === vesselId);
  const setup = useQuery(
    trpc.rates.setup.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const data = setup.data;
  const [planId, setPlanId] = useState('');
  const [seasonId, setSeasonId] = useState('');
  const [patternId, setPatternId] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [supplementDialog, setSupplementDialog] = useState<Supplement | 'add' | null>(null);
  const [planDialog, setPlanDialog] = useState<'add' | 'edit' | null>(null);
  const plansQuery = useQuery(
    trpc.rates.plans.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const policyError = usePolicyError();
  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.rates.setup.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.rates.plans.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.rates.policies.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.rates.seasons.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.home.setup.queryKey() });
  };
  const removePlan = useMutation(
    trpc.rates.deletePlan.mutationOptions({
      onSuccess: () => {
        setPlanId('');
        refreshAll();
      },
    }),
  );
  const removeSupplement = useMutation(
    trpc.rates.deleteSupplement.mutationOptions({ onSuccess: refreshAll }),
  );

  useEffect(() => {
    if (data && !data.plans.some((p) => p.id === planId)) setPlanId(data.plans[0]?.id ?? '');
    if (data && !data.seasons.some((s) => s.id === seasonId))
      setSeasonId(data.seasons[0]?.id ?? '');
  }, [data, planId, seasonId]);
  const plan = data?.plans.find((p) => p.id === planId);
  const perPackage = plan?.pricingPeriod === 'per_package';
  const pattern = perPackage ? patternId || data?.patterns[0]?.id || '' : '';
  const bases: (string | null)[] = plan?.pricingUnit === 'per_person' ? [...BASES] : [null];

  const current = new Map(
    (data?.rates ?? [])
      .filter(
        (r) =>
          r.ratePlanId === planId &&
          r.seasonId === seasonId &&
          (r.sailingPatternId ?? '') === (perPackage ? pattern : ''),
      )
      .map((r) => [cell(r.categoryId, r.basis), r.amount]),
  );
  const changes = Object.entries(edits).flatMap(([key, text]) => {
    const amount = parseMoney(text);
    if (amount === null || amount === current.get(key)) return [];
    const [categoryId, basis] = key.split(':') as [string, string];
    return [
      {
        categoryId,
        seasonId,
        sailingPatternId: perPackage ? pattern : undefined,
        basis: basis === '-' ? undefined : (basis as (typeof BASES)[number]),
        amount,
      },
    ];
  });
  const invalid = Object.values(edits).some(
    (text) => text.trim() !== '' && parseMoney(text) === null,
  );
  const save = useMutation(
    trpc.rates.set.mutationOptions({
      onSuccess: () => {
        setEdits({});
        setNotice(t('saved'));
        refreshAll();
      },
    }),
  );
  const fullPlan = plansQuery.data?.plans.find((p) => p.id === planId);
  const unitLabel = plan
    ? `${plan.pricingUnit === 'per_person' ? t('perPerson') : t('perCabin')} · ${
        plan.pricingPeriod === 'per_night' ? t('perNight') : t('perPackage')
      } · ${plan.currency}`
    : '';

  if (setup.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok">{notice}</Alert>}
      <Card
        actions={<VesselSelect vessels={vessels} value={vesselId} onChange={setVesselId} />}
        title={unitLabel}
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Field label={t('plan')}>
            <Select
              value={planId}
              onChange={(e) => {
                setPlanId(e.target.value);
                setEdits({});
              }}
            >
              {data?.plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} ·{' '}
                  {tbook.has(`market_${p.market}`) ? tbook(`market_${p.market}`) : p.market}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('season')}>
            <Select
              value={seasonId}
              onChange={(e) => {
                setSeasonId(e.target.value);
                setEdits({});
              }}
            >
              {data?.seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {perPackage && (
            <Field label={t('pattern')}>
              <Select
                value={pattern}
                onChange={(e) => {
                  setPatternId(e.target.value);
                  setEdits({});
                }}
              >
                {data?.patterns.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {canWrite && (
          <div className="mb-3 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setPlanDialog('add')}>
              + {t('newPlan')}
            </Button>
            {plan && (
              <Button variant="ghost" onClick={() => setPlanDialog('edit')}>
                {t('editPlan')}
              </Button>
            )}
            {fullPlan && fullPlan.rates === 0 && fullPlan.used === 0 && (
              <Button
                variant="ghost"
                disabled={removePlan.isPending}
                onClick={() => {
                  if (window.confirm(t('deletePlanConfirm', { code: fullPlan.code })))
                    removePlan.mutate({ ratePlanId: fullPlan.id });
                }}
              >
                {t('deletePlan')}
              </Button>
            )}
          </div>
        )}
        {removePlan.isError && (
          <div className="mb-3">
            <Alert tone="bad">{policyError(removePlan.error)}</Alert>
          </div>
        )}
        {data && data.plans.length === 0 ? (
          <Empty>{t('noPlans')}</Empty>
        ) : data && data.seasons.length === 0 ? (
          <Empty>{t('noSeasonsYet')}</Empty>
        ) : (
          <Table head={[t('category'), ...bases.map((b) => (b ? tb(b) : t('perCabin')))]}>
            {vessel?.categories.map((c) => (
              <tr key={c.id}>
                <Td>
                  <span className="font-medium">{c.code}</span>
                  <span className="block text-xs text-muted">
                    {locale.startsWith('ar') ? c.name_ar : c.name_en}
                  </span>
                </Td>
                {bases.map((b) => {
                  const key = cell(c.id, b);
                  const value = current.get(key);
                  const text = edits[key] ?? (value !== undefined ? minorToInput(value) : '');
                  return (
                    <Td key={key}>
                      {canWrite ? (
                        <Input
                          inputMode="decimal"
                          dir="ltr"
                          className="w-28 text-end tabular-nums"
                          value={text}
                          aria-label={`${c.code} ${b ?? ''}`}
                          onChange={(e) => setEdits({ ...edits, [key]: e.target.value })}
                        />
                      ) : value !== undefined && plan ? (
                        <span className="tabular-nums">
                          {formatMoney(value, plan.currency, locale)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </Table>
        )}
        {save.isError && (
          <div className="mt-3">
            <Alert tone="bad">{errorText(save.error)}</Alert>
          </div>
        )}
        {canWrite ? (
          <div className="mt-3 flex items-center gap-3">
            <Button
              disabled={changes.length === 0 || invalid || save.isPending}
              onClick={() => save.mutate({ ratePlanId: planId, rates: changes })}
            >
              {t('save')}
            </Button>
            {changes.length > 0 && (
              <span className="text-sm text-muted">{t('changed', { n: changes.length })}</span>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">{t('readOnly')}</p>
        )}
      </Card>

      <Card
        title={t('supplements')}
        actions={
          canWrite && (
            <Button variant="secondary" disabled={!plan} onClick={() => setSupplementDialog('add')}>
              + {t('addSupplement')}
            </Button>
          )
        }
      >
        {!data?.supplements.filter((s) => s.ratePlanId === planId).length ? (
          <p className="text-sm text-muted">{tc('none')}</p>
        ) : (
          <Table head={[t('code'), t('dates'), t('adult'), t('child'), '']}>
            {data.supplements
              .filter((s) => s.ratePlanId === planId)
              .map((s) => (
                <tr key={s.id}>
                  <Td>
                    <span className="font-medium">{s.code}</span>
                    <span className="block text-xs text-muted">
                      {locale.startsWith('ar') ? s.nameAr : s.nameEn}
                    </span>
                  </Td>
                  <Td>
                    {formatDate(s.dateFrom, locale)} – {formatDate(s.dateTo, locale)}
                  </Td>
                  <Td className="tabular-nums">
                    {plan && formatMoney(s.amountAdult, plan.currency, locale)}
                  </Td>
                  <Td className="tabular-nums">
                    {plan && formatMoney(s.amountChild, plan.currency, locale)}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {s.mandatory && <Badge tone="info">{t('mandatory')}</Badge>}
                      {canWrite && (
                        <>
                          <Button variant="ghost" onClick={() => setSupplementDialog(s)}>
                            {t('editSupplement')}
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={removeSupplement.isPending}
                            onClick={() => {
                              if (window.confirm(t('deleteSupplementConfirm', { code: s.code })))
                                removeSupplement.mutate({ supplementId: s.id });
                            }}
                          >
                            {t('deleteSupplement')}
                          </Button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
          </Table>
        )}
      </Card>

      {vesselId && <SeasonsCard vesselId={vesselId} canWrite={canWrite} />}
      <PoliciesSection canWrite={canWrite} />

      {supplementDialog && plan && (
        <SupplementDialog
          ratePlanId={plan.id}
          supplement={supplementDialog === 'add' ? undefined : supplementDialog}
          onClose={() => setSupplementDialog(null)}
          onDone={refreshAll}
        />
      )}
      {planDialog && vesselId && (
        <PlanDialog
          vesselId={vesselId}
          plan={planDialog === 'edit' ? fullPlan : undefined}
          contracts={plansQuery.data?.contracts ?? []}
          onClose={() => setPlanDialog(null)}
          onDone={(id) => {
            setPlanId(id);
            refreshAll();
          }}
        />
      )}
    </div>
  );
}

interface Supplement {
  id: string;
  code: string;
  kind?: string;
  nameEn: string;
  nameAr: string;
  dateFrom: string;
  dateTo: string;
  amountAdult: bigint;
  amountChild: bigint;
  mandatory: boolean;
}

function SupplementDialog({
  ratePlanId,
  supplement,
  onClose,
  onDone,
}: {
  ratePlanId: string;
  supplement?: Supplement;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('rates');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const policyError = usePolicyError();
  const [form, setForm] = useState({
    code: supplement?.code ?? '',
    kind: (supplement?.kind ?? 'gala') as 'gala' | 'peak' | 'other',
    nameEn: supplement?.nameEn ?? '',
    nameAr: supplement?.nameAr ?? '',
    dateFrom: supplement?.dateFrom ?? '',
    dateTo: supplement?.dateTo ?? '',
    adult: supplement ? minorToInput(supplement.amountAdult) : '',
    child: supplement ? minorToInput(supplement.amountChild) : '',
    mandatory: supplement?.mandatory ?? true,
  });
  const done = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.rates.setup.queryKey() });
      onDone();
      onClose();
    },
  };
  const add = useMutation(trpc.rates.addSupplement.mutationOptions(done));
  const update = useMutation(trpc.rates.updateSupplement.mutationOptions(done));
  const failed = add.error ?? update.error;
  const adult = parseMoney(form.adult);
  const child = parseMoney(form.child || '0');
  return (
    <Dialog
      open
      onClose={onClose}
      title={supplement ? `${t('editSupplement')} · ${supplement.code}` : t('addSupplement')}
    >
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (adult === null || child === null) return;
          const fields = {
            kind: form.kind,
            nameEn: form.nameEn.trim(),
            nameAr: form.nameAr.trim(),
            dateFrom: form.dateFrom,
            dateTo: form.dateTo,
            amountAdult: adult,
            amountChild: child,
            mandatory: form.mandatory,
          };
          if (supplement) update.mutate({ supplementId: supplement.id, ...fields });
          else add.mutate({ ratePlanId, code: form.code.trim().toUpperCase(), ...fields });
        }}
      >
        <Field label={t('code')}>
          <Input
            required
            dir="ltr"
            className="uppercase"
            disabled={Boolean(supplement)}
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
          />
        </Field>
        <Field label={t('kind')}>
          <Select
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}
          >
            {(['gala', 'peak', 'other'] as const).map((k) => (
              <option key={k} value={k}>
                {t(`kind_${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('nameEn')}>
          <Input
            required
            dir="ltr"
            value={form.nameEn}
            onChange={(e) => setForm({ ...form, nameEn: e.target.value })}
          />
        </Field>
        <Field label={t('nameAr')}>
          <Input
            required
            dir="rtl"
            value={form.nameAr}
            onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
          />
        </Field>
        <Field label={tc('from')}>
          <Input
            required
            type="date"
            value={form.dateFrom}
            onChange={(e) => setForm({ ...form, dateFrom: e.target.value })}
          />
        </Field>
        <Field label={tc('to')}>
          <Input
            required
            type="date"
            value={form.dateTo}
            onChange={(e) => setForm({ ...form, dateTo: e.target.value })}
          />
        </Field>
        <Field label={t('adult')} error={form.adult && adult === null ? tc('error') : undefined}>
          <Input
            required
            inputMode="decimal"
            dir="ltr"
            value={form.adult}
            onChange={(e) => setForm({ ...form, adult: e.target.value })}
          />
        </Field>
        <Field label={t('child')} error={form.child && child === null ? tc('error') : undefined}>
          <Input
            inputMode="decimal"
            dir="ltr"
            value={form.child}
            onChange={(e) => setForm({ ...form, child: e.target.value })}
          />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.mandatory}
            onChange={(e) => setForm({ ...form, mandatory: e.target.checked })}
          />
          {t('mandatory')}
        </label>
        {failed && (
          <div className="col-span-2">
            <Alert tone="bad">{policyError(failed)}</Alert>
          </div>
        )}
        <div className="col-span-2 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {tc('close')}
          </Button>
          <Button
            type="submit"
            disabled={adult === null || child === null || add.isPending || update.isPending}
          >
            {tc('save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
