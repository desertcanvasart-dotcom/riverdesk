'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Empty } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import {
  AllotmentDialog,
  ChannelDialog,
  ClientDialog,
  ContractDialog,
  DeliveriesDialog,
  EndpointDialog,
  SecretShown,
  type Vessel,
} from './channel-dialogs';

type Open =
  | { kind: 'channel' }
  | { kind: 'contract' | 'allotment' | 'client' | 'endpoint'; channelId: string }
  | { kind: 'deliveries'; endpointId: string; url: string }
  | null;

export function ChannelsScreen({
  vessels,
  canChannels,
  canInventory,
}: {
  vessels: Vessel[];
  canChannels: boolean;
  canInventory: boolean;
}) {
  const t = useTranslations('channels');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const list = useQuery(trpc.channels.list.queryOptions());
  const [open, setOpen] = useState<Open>(null);
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.channels.list.queryKey() });
  const updateContract = useMutation(
    trpc.channels.updateContract.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const addSecret = useMutation(
    trpc.channels.addSecret.mutationOptions({
      onSuccess: (r) => {
        setSecret({ label: t('rotate'), value: r.secret });
        void refresh();
      },
    }),
  );
  const revokeSecret = useMutation(
    trpc.channels.revokeSecret.mutationOptions({ onSuccess: () => void refresh() }),
  );
  const failed = [updateContract, addSecret, revokeSecret].find((m) => m.isError);
  const done = (shown?: { label: string; value: string }) => {
    setOpen(null);
    if (shown) setSecret(shown);
    void refresh();
  };

  if (list.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <div className="flex flex-col gap-4">
      {secret && (
        <SecretShown label={secret.label} value={secret.value} onClose={() => setSecret(null)} />
      )}
      {failed && <Alert tone="bad">{errorText(failed.error)}</Alert>}
      {canChannels && (
        <div>
          <Button onClick={() => setOpen({ kind: 'channel' })}>+ {t('newChannel')}</Button>
        </div>
      )}
      {list.data?.map((c) => (
        <Card
          key={c.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {c.name}
              <Badge tone="info">{t(`type_${c.type}` as 'type_agent')}</Badge>
              {!c.active && <Badge tone="neutral">{t('inactive')}</Badge>}
            </span>
          }
          actions={
            c.creditAllowed &&
            c.creditLimit !== null &&
            c.creditCurrency && (
              <span className="text-sm text-muted">
                {t('credit')} {formatMoney(c.creditLimit, c.creditCurrency, locale)}
              </span>
            )
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <section>
              <SectionHead
                title={t('contracts')}
                action={
                  canChannels &&
                  c.type !== 'back_office' && (
                    <Button
                      variant="ghost"
                      onClick={() => setOpen({ kind: 'contract', channelId: c.id })}
                    >
                      + {t('newContract')}
                    </Button>
                  )
                }
              />
              {c.contracts.length === 0 && <p className="text-sm text-muted">{t('none')}</p>}
              <ul className="divide-y divide-line text-sm">
                {c.contracts.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <span className="font-medium">{k.vessel}</span> ·{' '}
                      {t(`allocation_${k.allocation}` as 'allocation_pool')} ·{' '}
                      {t(`paymentMode_${k.paymentMode}` as 'paymentMode_credit')}
                      <span className="block text-xs text-muted">
                        {t(`adjustment_${k.priceAdjustment}` as 'adjustment_markup', {
                          p: k.adjustmentBps / 100,
                        })}{' '}
                        · {t('holds', { m: k.checkoutHoldMinutes, h: k.optionHoldHours })}
                        {k.allocation === 'on_request' &&
                          ` · ${t('sla', { h: k.requestSlaHours })}`}{' '}
                        · {t('validFrom', { date: formatDate(k.validFrom, locale) })}
                      </span>
                      {k.stopSell && <Badge tone="bad">{t('stopped')}</Badge>}
                      {k.paymentMode === 'credit' && (
                        <span className="block text-xs text-muted">
                          {t(`creditMode_${k.creditLimitMode as 'block'}`)}
                        </span>
                      )}
                    </span>
                    {canChannels && k.paymentMode === 'credit' && (
                      <Button
                        variant="ghost"
                        disabled={updateContract.isPending}
                        onClick={() =>
                          updateContract.mutate({
                            contractId: k.id,
                            creditLimitMode: k.creditLimitMode === 'warn' ? 'block' : 'warn',
                          })
                        }
                      >
                        {k.creditLimitMode === 'warn'
                          ? t('creditModeToBlock')
                          : t('creditModeToWarn')}
                      </Button>
                    )}
                    {canChannels && (
                      <Button
                        variant="ghost"
                        disabled={updateContract.isPending}
                        onClick={() =>
                          updateContract.mutate({ contractId: k.id, stopSell: !k.stopSell })
                        }
                      >
                        {k.stopSell ? t('resumeSell') : t('stopSell')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {c.type !== 'back_office' && (
              <section>
                <SectionHead
                  title={t('allotments')}
                  action={
                    canInventory && (
                      <Button
                        variant="ghost"
                        onClick={() => setOpen({ kind: 'allotment', channelId: c.id })}
                      >
                        + {t('newAllotment')}
                      </Button>
                    )
                  }
                />
                {c.allotments.length === 0 && (
                  <p className="text-sm text-muted">{t('noAllotments')}</p>
                )}
                <ul className="divide-y divide-line text-sm">
                  {c.allotments.map((a) => (
                    <li key={a.id} className="py-2">
                      <span className="font-medium">{a.vessel}</span>
                      {a.firstDate && (
                        <>
                          {' '}
                          · {formatDate(a.firstDate, locale)} – {formatDate(a.lastDate!, locale)}
                        </>
                      )}
                      <span className="block text-xs text-muted">
                        {t('allotmentLine', { cabins: a.cabins, legs: a.legs, booked: a.booked })} ·{' '}
                        {t('releaseDays', { n: a.releaseDays })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {c.type !== 'back_office' && (
              <section>
                <SectionHead
                  title={t('apiClients')}
                  action={
                    canChannels && (
                      <Button
                        variant="ghost"
                        onClick={() => setOpen({ kind: 'client', channelId: c.id })}
                      >
                        + {t('newClient')}
                      </Button>
                    )
                  }
                />
                {c.clients.length === 0 && <p className="text-sm text-muted">{t('none')}</p>}
                <ul className="divide-y divide-line text-sm">
                  {c.clients.map((k) => (
                    <li key={k.id} className="py-2">
                      <span className="font-medium">{k.name}</span>{' '}
                      <code className="text-xs" dir="ltr">
                        {k.clientId}
                      </code>
                      <span className="block text-xs text-muted">
                        {t('rateLimit', { n: k.rateLimitPerMinute })}
                      </span>
                      <ul className="mt-1 flex flex-col gap-1">
                        {k.secrets.map((s) => (
                          <li
                            key={s.id}
                            className="flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <span>
                              <span dir="ltr">{t('secretHint', { hint: s.hint })}</span> ·{' '}
                              {s.lastUsedAt
                                ? t('lastUsed', { when: formatDateTime(s.lastUsedAt, locale) })
                                : t('neverUsed')}
                            </span>
                            {canChannels && k.secrets.length > 1 && (
                              <Button
                                variant="ghost"
                                onClick={() => revokeSecret.mutate({ secretId: s.id })}
                              >
                                {t('revoke')}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                      {canChannels && k.secrets.length < 2 && (
                        <Button
                          variant="ghost"
                          className="mt-1"
                          disabled={addSecret.isPending}
                          onClick={() => addSecret.mutate({ apiClientId: k.id })}
                        >
                          {t('rotate')}
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {c.type !== 'back_office' && (
              <section>
                <SectionHead
                  title={t('webhooks')}
                  action={
                    canChannels && (
                      <Button
                        variant="ghost"
                        onClick={() => setOpen({ kind: 'endpoint', channelId: c.id })}
                      >
                        + {t('newEndpoint')}
                      </Button>
                    )
                  }
                />
                {c.endpoints.length === 0 && <p className="text-sm text-muted">{t('none')}</p>}
                <ul className="divide-y divide-line text-sm">
                  {c.endpoints.map((w) => (
                    <li
                      key={w.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate" dir="ltr">
                          {w.url}
                        </span>
                        <span className="flex flex-wrap gap-1 text-xs">
                          <Badge tone="ok">
                            {t('delivered')} {w.delivered}
                          </Badge>
                          {w.pending > 0 && (
                            <Badge tone="warn">
                              {t('pending')} {w.pending}
                            </Badge>
                          )}
                          {w.dead > 0 && (
                            <Badge tone="bad">
                              {t('dead')} {w.dead}
                            </Badge>
                          )}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        onClick={() =>
                          setOpen({ kind: 'deliveries', endpointId: w.id, url: w.url })
                        }
                      >
                        {t('deliveries')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </Card>
      ))}

      {open?.kind === 'channel' && (
        <ChannelDialog onClose={() => setOpen(null)} onDone={() => done()} />
      )}
      {open?.kind === 'contract' && (
        <ContractDialog
          channelId={open.channelId}
          vessels={vessels}
          onClose={() => setOpen(null)}
          onDone={() => done()}
        />
      )}
      {open?.kind === 'allotment' && (
        <AllotmentDialog
          channelId={open.channelId}
          vessels={vessels}
          onClose={() => setOpen(null)}
          onDone={() => done()}
        />
      )}
      {open?.kind === 'client' && (
        <ClientDialog
          channelId={open.channelId}
          onClose={() => setOpen(null)}
          onDone={(shown) => done(shown)}
        />
      )}
      {open?.kind === 'endpoint' && (
        <EndpointDialog
          channelId={open.channelId}
          onClose={() => setOpen(null)}
          onDone={(shown) => done(shown)}
        />
      )}
      {open?.kind === 'deliveries' && (
        <DeliveriesDialog
          endpointId={open.endpointId}
          url={open.url}
          canReplay={canChannels}
          onClose={() => {
            setOpen(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function SectionHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {action}
    </div>
  );
}
