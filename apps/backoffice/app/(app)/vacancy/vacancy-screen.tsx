'use client';

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { DocumentButtons } from '../../../components/documents';
import { VesselSelect } from '../../../components/range-nav';
import { Card, Empty, Field, Input, Select, Table, Td, cx } from '../../../components/ui';
import { cairoTodayIso } from '../../../lib/dates';
import { formatDate } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';

export function VacancyScreen({
  vessels,
  canDocuments,
}: {
  vessels: { id: string; name: string }[];
  canDocuments: boolean;
}) {
  const t = useTranslations('vacancy');
  const tc = useTranslations('common');
  const td = useTranslations('documents');
  const locale = useLocale();
  const trpc = useTRPC();
  const [vesselId, setVesselId] = useState(vessels[0]?.id ?? '');
  const [from, setFrom] = useState(() => cairoTodayIso());
  const [weeks, setWeeks] = useState(4);
  const sheet = useQuery(
    trpc.documents.vacancy.queryOptions({ vesselId, from, weeks }, { enabled: Boolean(vesselId) }),
  );
  const v = sheet.data;
  return (
    <div className="flex flex-col gap-4">
      <Card actions={<VesselSelect vessels={vessels} value={vesselId} onChange={setVesselId} />}>
        <div className="grid grid-cols-2 gap-3 sm:w-96">
          <Field label={t('from')}>
            <Input
              type="date"
              value={from}
              onChange={(e) => e.target.value && setFrom(e.target.value)}
            />
          </Field>
          <Field label={t('weeks')}>
            <Select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
              {[1, 2, 3, 4, 6, 8].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {canDocuments && (
          <div className="mt-4">
            <DocumentButtons
              items={[
                {
                  key: 'pdf',
                  label: 'PDF',
                  input: { kind: 'vacancy_sheet', vesselId, from, weeks, format: 'pdf' },
                },
                {
                  key: 'xlsx',
                  label: 'Excel',
                  input: { kind: 'vacancy_sheet', vesselId, from, weeks, format: 'xlsx' },
                },
                {
                  key: 'outage',
                  label: td('outage_pack'),
                  input: { kind: 'outage_pack', vesselId },
                },
                {
                  key: 'png',
                  label: t('png'),
                  input: { kind: 'vacancy_sheet', vesselId, from, weeks, format: 'png' },
                },
              ]}
            />
          </div>
        )}
      </Card>
      <Card title={td('vacancy_sheet')}>
        {sheet.isLoading ? (
          <Empty>{tc('loading')}</Empty>
        ) : !v?.sailings.length ? (
          <Empty>{tc('none')}</Empty>
        ) : (
          <Table head={['', ...v.categories.map((c) => c.code)]}>
            {v.sailings.map((s) => (
              <tr key={`${s.embarkDate}-${s.patternCode}`}>
                <Td className="whitespace-nowrap">
                  <span className="font-medium">{formatDate(s.embarkDate, locale)}</span>
                  <span className="block text-xs text-muted">
                    {s.embark[locale.startsWith('ar') ? 'ar' : 'en']} –{' '}
                    {s.disembark[locale.startsWith('ar') ? 'ar' : 'en']} ·{' '}
                    {tc('nights', { n: s.nights })}
                  </span>
                </Td>
                {v.categories.map((c) => {
                  const free = s.free[c.id] ?? 0;
                  return (
                    <Td
                      key={c.id}
                      className={cx(
                        'text-center font-semibold tabular-nums',
                        free === 0 ? 'text-bad' : free <= 2 ? 'text-warn' : 'text-ok',
                      )}
                    >
                      {free}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
