'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
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
import { formatDateTime } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { BrandingCard } from './branding-card';
import { MarketsCard } from './markets-card';
import { OperationsCard } from './operations-card';

const ROLES = ['owner', 'reservations', 'finance', 'read_only', 'onboard'] as const;
const NUMBERS = [
  'checkoutHoldMinutes',
  'optionHoldHours',
  'offerHoldHours',
  'paymentHoldHours',
  'requestSlaHours',
  'requestGraceHours',
  'assignmentCutoffDays',
  'allotmentReleaseDays',
  'passportRetentionDays',
] as const;
type NumberKey = (typeof NUMBERS)[number];

export function SettingsScreen({ canWrite, selfId }: { canWrite: boolean; selfId: string }) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const tr = useTranslations('roles');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const operator = useQuery(trpc.settings.operator.queryOptions());
  const staff = useQuery(trpc.settings.staff.queryOptions());
  // An on-board login belongs to one vessel.
  const vessels = useQuery(trpc.book.vessels.queryOptions());
  const firstVessel = vessels.data?.[0]?.id ?? null;
  const vesselName = (id: string | null) => vessels.data?.find((v) => v.id === id)?.name ?? '';
  const [form, setForm] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [invite, setInvite] = useState({
    email: '',
    displayName: '',
    role: 'reservations' as (typeof ROLES)[number],
    vesselId: null as string | null,
  });
  useEffect(() => {
    if (operator.data)
      setForm({
        name: operator.data.name,
        defaultLocale: operator.data.defaultLocale,
        ...Object.fromEntries(NUMBERS.map((k) => [k, String(operator.data[k])])),
        emergencyPhone: operator.data.emergencyPhone ?? '',
        opsEmail: operator.data.opsEmail ?? '',
        voucherNoteEn: operator.data.voucherNoteEn ?? '',
        voucherNoteAr: operator.data.voucherNoteAr ?? '',
      });
  }, [operator.data]);
  const refreshStaff = () =>
    queryClient.invalidateQueries({ queryKey: trpc.settings.staff.queryKey() });
  const save = useMutation(
    trpc.settings.updateOperator.mutationOptions({
      onSuccess: () => {
        setNotice(t('saved'));
        void queryClient.invalidateQueries({ queryKey: trpc.settings.operator.queryKey() });
      },
    }),
  );
  const sendInvite = useMutation(
    trpc.settings.invite.mutationOptions({
      onSuccess: () => {
        setNotice(t('invited'));
        setInvite({ email: '', displayName: '', role: 'reservations', vesselId: null });
        void refreshStaff();
      },
    }),
  );
  const revoke = useMutation(
    trpc.settings.revokeInvitation.mutationOptions({ onSuccess: () => void refreshStaff() }),
  );
  const update = useMutation(
    trpc.settings.updateStaff.mutationOptions({ onSuccess: () => void refreshStaff() }),
  );
  const failed = [save, sendInvite, revoke, update].find((m) => m.isError);

  if (operator.isLoading || staff.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <div className="flex flex-col gap-4">
      {notice && <Alert tone="ok">{notice}</Alert>}
      {failed && <Alert tone="bad">{errorText(failed.error)}</Alert>}

      <Card title={t('staff')}>
        <Table head={[t('name'), t('email'), t('role'), t('active')]}>
          {staff.data?.staff.map((s) => (
            <tr key={s.id}>
              <Td>
                {s.displayName} {s.id === selfId && <Badge tone="info">{t('you')}</Badge>}
              </Td>
              <Td>
                <span dir="ltr">{s.email}</span>
              </Td>
              <Td>
                {canWrite ? (
                  <div className="flex flex-wrap gap-2">
                    <Select
                      value={s.role}
                      aria-label={t('role')}
                      onChange={(e) => {
                        const role = e.target.value as (typeof ROLES)[number];
                        update.mutate({
                          staffUserId: s.id,
                          role,
                          vesselId: role === 'onboard' ? (s.vesselId ?? firstVessel) : null,
                        });
                      }}
                    >
                      {ROLES.map((r) => (
                        <option key={r} value={r}>
                          {tr(r)}
                        </option>
                      ))}
                    </Select>
                    {s.role === 'onboard' && (
                      <Select
                        value={s.vesselId ?? ''}
                        aria-label={t('vessel')}
                        onChange={(e) =>
                          update.mutate({ staffUserId: s.id, vesselId: e.target.value })
                        }
                      >
                        {vessels.data?.map((v) => (
                          <option key={v.id} value={v.id}>
                            {v.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                ) : (
                  <>
                    {tr(s.role as (typeof ROLES)[number])}
                    {s.role === 'onboard' && ` · ${vesselName(s.vesselId)}`}
                  </>
                )}
              </Td>
              <Td>
                {canWrite && s.id !== selfId ? (
                  <Button
                    variant="ghost"
                    onClick={() => update.mutate({ staffUserId: s.id, active: !s.active })}
                  >
                    {s.active ? t('deactivate') : t('reactivate')}
                  </Button>
                ) : (
                  <Badge tone={s.active ? 'ok' : 'neutral'}>{s.active ? t('active') : '—'}</Badge>
                )}
              </Td>
            </tr>
          ))}
        </Table>

        {(staff.data?.invitations.length ?? 0) > 0 && (
          <>
            <h3 className="mt-4 mb-1 text-sm font-medium">{t('invitations')}</h3>
            <ul className="divide-y divide-line text-sm">
              {staff.data!.invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>
                    {i.displayName} · <span dir="ltr">{i.email}</span> ·{' '}
                    {tr(i.role as (typeof ROLES)[number])}
                    {i.role === 'onboard' && ` · ${vesselName(i.vesselId)}`}
                    <span className="block text-xs text-muted">
                      {t('expires', { date: formatDateTime(i.expiresAt, locale) })}
                    </span>
                  </span>
                  {canWrite && (
                    <Button variant="ghost" onClick={() => revoke.mutate({ invitationId: i.id })}>
                      {t('revoke')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {canWrite && (
          <form
            className="mt-4 grid gap-2 sm:auto-cols-fr sm:grid-flow-col sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              sendInvite.mutate({
                ...invite,
                email: invite.email.trim(),
                displayName: invite.displayName.trim(),
              });
            }}
          >
            <Field label={t('email')}>
              <Input
                type="email"
                required
                dir="ltr"
                value={invite.email}
                onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              />
            </Field>
            <Field label={t('name')}>
              <Input
                required
                value={invite.displayName}
                onChange={(e) => setInvite({ ...invite, displayName: e.target.value })}
              />
            </Field>
            <Field label={t('role')}>
              <Select
                value={invite.role}
                onChange={(e) => {
                  const role = e.target.value as (typeof ROLES)[number];
                  setInvite({
                    ...invite,
                    role,
                    vesselId: role === 'onboard' ? (invite.vesselId ?? firstVessel) : null,
                  });
                }}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {tr(r)}
                  </option>
                ))}
              </Select>
            </Field>
            {invite.role === 'onboard' && (
              <Field label={t('vessel')}>
                <Select
                  value={invite.vesselId ?? ''}
                  onChange={(e) => setInvite({ ...invite, vesselId: e.target.value })}
                >
                  {vessels.data?.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Button type="submit" disabled={sendInvite.isPending}>
              {t('invite')}
            </Button>
          </form>
        )}
      </Card>

      <MarketsCard canWrite={canWrite} />
      <OperationsCard canWrite={canWrite} />

      <Card title={t('company')}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const numbers = Object.fromEntries(NUMBERS.map((k) => [k, Number(form[k])])) as Record<
              NumberKey,
              number
            >;
            save.mutate({
              name: form.name,
              defaultLocale: form.defaultLocale === 'en' ? 'en' : 'ar',
              ...numbers,
              emergencyPhone: form.emergencyPhone || null,
              opsEmail: form.opsEmail || null,
              voucherNoteEn: form.voucherNoteEn || null,
              voucherNoteAr: form.voucherNoteAr || null,
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('companyName')}>
              <Input
                required
                disabled={!canWrite}
                value={form.name ?? ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label={t('defaultLocale')}>
              <Select
                disabled={!canWrite}
                value={form.defaultLocale ?? 'ar'}
                onChange={(e) => setForm({ ...form, defaultLocale: e.target.value })}
              >
                <option value="ar">العربية</option>
                <option value="en">English</option>
              </Select>
            </Field>
            <Field label={t('refPrefix')}>
              <Input disabled dir="ltr" value={operator.data?.bookingRefPrefix ?? ''} />
            </Field>
          </div>
          <div>
            <h3 className="text-sm font-medium">{t('defaults')}</h3>
            <p className="mb-2 text-xs text-muted">{t('defaultsHelp')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {NUMBERS.map((k) => (
                <Field key={k} label={t(k)}>
                  <Input
                    type="number"
                    min={0}
                    required
                    disabled={!canWrite}
                    value={form[k] ?? ''}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                  />
                </Field>
              ))}
            </div>
          </div>
          <div>
            <h3 className="mb-2 text-sm font-medium">{t('voucherSection')}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('opsEmail')}>
                <Input
                  type="email"
                  dir="ltr"
                  disabled={!canWrite}
                  value={form.opsEmail ?? ''}
                  onChange={(e) => setForm({ ...form, opsEmail: e.target.value })}
                />
              </Field>
              <Field label={t('emergencyPhone')}>
                <Input
                  dir="ltr"
                  disabled={!canWrite}
                  value={form.emergencyPhone ?? ''}
                  onChange={(e) => setForm({ ...form, emergencyPhone: e.target.value })}
                />
              </Field>
              <Field label={t('voucherNoteEn')}>
                <textarea
                  dir="ltr"
                  rows={3}
                  disabled={!canWrite}
                  className="w-full rounded-lg border border-line bg-surface p-2 text-sm"
                  value={form.voucherNoteEn ?? ''}
                  onChange={(e) => setForm({ ...form, voucherNoteEn: e.target.value })}
                />
              </Field>
              <Field label={t('voucherNoteAr')}>
                <textarea
                  dir="rtl"
                  rows={3}
                  disabled={!canWrite}
                  className="w-full rounded-lg border border-line bg-surface p-2 text-sm"
                  value={form.voucherNoteAr ?? ''}
                  onChange={(e) => setForm({ ...form, voucherNoteAr: e.target.value })}
                />
              </Field>
            </div>
          </div>
          {canWrite && (
            <div>
              <Button type="submit" disabled={save.isPending}>
                {t('save')}
              </Button>
            </div>
          )}
        </form>
      </Card>

      <BrandingCard canWrite={canWrite} />
    </div>
  );
}
