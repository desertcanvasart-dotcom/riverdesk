'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, Select } from '../../../components/ui';
import { useErrorText } from '../../../lib/errors';
import { useTRPC } from '../../../lib/trpc';

const TIMES = [
  'boardingTime',
  'breakfastTime',
  'lunchTime',
  'teaTime',
  'dinnerTime',
  'luggageTime',
  'checkoutTime',
] as const;
const TEXTS = [
  'whatToBringAr',
  'whatToBringEn',
  'dressCodeAr',
  'dressCodeEn',
  'documentsAr',
  'documentsEn',
] as const;

const Area = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea
    rows={3}
    className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
    {...props}
  />
);

/**
 * On board and before sailing (Batch D3): what the daily programme, the disembarkation list and
 * the guest's pre-departure sheet print — each vessel's times, each port's berth and visits, and
 * the company's own wording (standard wording is used where it is left empty).
 */
export function OperationsCard({ canWrite }: { canWrite: boolean }) {
  const t = useTranslations('operations');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const data = useQuery(trpc.settings.operations.queryOptions());
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: trpc.settings.operations.queryKey() });
  const [vesselId, setVesselId] = useState('');
  const [portId, setPortId] = useState('');
  const vessel = data.data?.vessels.find((v) => v.id === (vesselId || data.data?.vessels[0]?.id));
  const port = data.data?.ports.find((p) => p.id === (portId || data.data?.ports[0]?.id));
  const [times, setTimes] = useState<Record<string, string>>({});
  const [portForm, setPortForm] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!vessel) return;
    setTimes({
      ...Object.fromEntries(TIMES.map((k) => [k, vessel[k] ?? ''])),
      programmeNoteAr: vessel.programmeNoteAr ?? '',
      programmeNoteEn: vessel.programmeNoteEn ?? '',
    });
  }, [vessel?.id, data.dataUpdatedAt]);
  useEffect(() => {
    if (!port) return;
    setPortForm({
      berthAr: port.berthAr ?? '',
      berthEn: port.berthEn ?? '',
      visitsAr: port.visitsAr ?? '',
      visitsEn: port.visitsEn ?? '',
    });
  }, [port?.id, data.dataUpdatedAt]);
  useEffect(() => {
    if (!data.data) return;
    setTexts(Object.fromEntries(TEXTS.map((k) => [k, data.data.guestInfo[k] ?? ''])));
  }, [data.dataUpdatedAt]);
  const saveVessel = useMutation(
    trpc.settings.updateVesselDay.mutationOptions({ onSuccess: refresh }),
  );
  const savePort = useMutation(
    trpc.settings.updatePortGuide.mutationOptions({ onSuccess: refresh }),
  );
  const saveTexts = useMutation(
    trpc.settings.updateGuestInfo.mutationOptions({ onSuccess: refresh }),
  );
  const error = [saveVessel, savePort, saveTexts].find((m) => m.isError)?.error;
  if (!data.data) return null;
  const name = (p: { nameAr: string; nameEn: string }) =>
    locale.startsWith('ar') ? p.nameAr : p.nameEn;

  return (
    <Card title={t('title')}>
      <p className="mb-4 text-sm text-muted">{t('subtitle')}</p>
      {error && <Alert tone="bad">{errorText(error)}</Alert>}

      <section className="mb-6">
        <h3 className="mb-2 font-medium">{t('vesselDay')}</h3>
        {data.data.vessels.length > 1 && (
          <Field label={t('vessel')}>
            <Select value={vessel?.id ?? ''} onChange={(e) => setVesselId(e.target.value)}>
              {data.data.vessels.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {TIMES.map((k) => (
            <Field key={k} label={t(k)}>
              <Input
                type="time"
                disabled={!canWrite}
                value={times[k] ?? ''}
                onChange={(e) => setTimes({ ...times, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={t('programmeNoteAr')}>
            <Area
              dir="rtl"
              disabled={!canWrite}
              value={times.programmeNoteAr ?? ''}
              onChange={(e) => setTimes({ ...times, programmeNoteAr: e.target.value })}
            />
          </Field>
          <Field label={t('programmeNoteEn')}>
            <Area
              dir="ltr"
              disabled={!canWrite}
              value={times.programmeNoteEn ?? ''}
              onChange={(e) => setTimes({ ...times, programmeNoteEn: e.target.value })}
            />
          </Field>
        </div>
        {canWrite && vessel && (
          <Button
            className="mt-3"
            disabled={saveVessel.isPending}
            onClick={() =>
              saveVessel.mutate({
                vesselId: vessel.id,
                ...Object.fromEntries(TIMES.map((k) => [k, times[k] || null])),
                programmeNoteAr: times.programmeNoteAr || null,
                programmeNoteEn: times.programmeNoteEn || null,
              })
            }
          >
            {tc('save')}
          </Button>
        )}
      </section>

      {data.data.ports.length > 0 && (
        <section className="mb-6">
          <h3 className="mb-2 font-medium">{t('portGuide')}</h3>
          <Field label={t('port')}>
            <Select value={port?.id ?? ''} onChange={(e) => setPortId(e.target.value)}>
              {data.data.ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {name(p)}
                </option>
              ))}
            </Select>
          </Field>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {(['berthAr', 'berthEn', 'visitsAr', 'visitsEn'] as const).map((k) => (
              <Field key={k} label={t(k)}>
                <Area
                  dir={k.endsWith('Ar') ? 'rtl' : 'ltr'}
                  disabled={!canWrite}
                  value={portForm[k] ?? ''}
                  onChange={(e) => setPortForm({ ...portForm, [k]: e.target.value })}
                />
              </Field>
            ))}
          </div>
          {canWrite && port && (
            <Button
              className="mt-3"
              disabled={savePort.isPending}
              onClick={() =>
                savePort.mutate({
                  portId: port.id,
                  berthAr: portForm.berthAr || null,
                  berthEn: portForm.berthEn || null,
                  visitsAr: portForm.visitsAr || null,
                  visitsEn: portForm.visitsEn || null,
                })
              }
            >
              {tc('save')}
            </Button>
          )}
        </section>
      )}

      <section>
        <h3 className="mb-2 font-medium">{t('guestInfo')}</h3>
        <p className="mb-2 text-sm text-muted">{t('guestInfoHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEXTS.map((k) => (
            <Field key={k} label={t(k)}>
              <Area
                rows={k.startsWith('whatToBring') ? 5 : 3}
                dir={k.endsWith('Ar') ? 'rtl' : 'ltr'}
                disabled={!canWrite}
                value={texts[k] ?? ''}
                onChange={(e) => setTexts({ ...texts, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        {canWrite && (
          <Button
            className="mt-3"
            disabled={saveTexts.isPending}
            onClick={() =>
              saveTexts.mutate(Object.fromEntries(TEXTS.map((k) => [k, texts[k] || null])))
            }
          >
            {tc('save')}
          </Button>
        )}
      </section>
    </Card>
  );
}
