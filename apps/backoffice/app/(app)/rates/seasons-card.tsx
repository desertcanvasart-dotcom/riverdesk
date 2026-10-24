'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { Dialog } from '../../../components/dialog';
import { Alert, Badge, Button, Card, Field, Input } from '../../../components/ui';
import { formatDate } from '../../../lib/format';
import { useTRPC } from '../../../lib/trpc';
import { usePolicyError } from './policy-errors';

interface Season {
  id: string;
  code: string;
  name: string;
  periods: { from: string; to: string }[];
  rates: number;
}

/** A ship's seasons: which dates are priced as which season. */
export function SeasonsCard({ vesselId, canWrite }: { vesselId: string; canWrite: boolean }) {
  const t = useTranslations('policies');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const policyError = usePolicyError();
  const data = useQuery(
    trpc.rates.seasons.queryOptions({ vesselId }, { enabled: Boolean(vesselId) }),
  );
  const [editing, setEditing] = useState<Season | 'add' | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.rates.seasons.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.rates.setup.queryKey() });
  };
  const remove = useMutation(trpc.rates.deleteSeason.mutationOptions({ onSuccess: refresh }));
  const seasons = data.data?.seasons ?? [];
  const uncovered = data.data?.uncovered ?? [];
  const range = (r: { from: string; to: string }) =>
    r.from === r.to
      ? formatDate(r.from, locale, 'year')
      : `${formatDate(r.from, locale, 'year')} – ${formatDate(r.to, locale, 'year')}`;
  return (
    <Card
      title={t('seasons')}
      actions={
        canWrite && (
          <Button variant="secondary" onClick={() => setEditing('add')}>
            + {t('addSeason')}
          </Button>
        )
      }
    >
      {uncovered.length > 0 && (
        <div className="mb-3">
          <Alert tone="warn">
            {t('uncovered', {
              ranges: uncovered
                .slice(0, 6)
                .map(range)
                .join(locale.startsWith('ar') ? '، ' : ', '),
            })}
            {uncovered.length > 6 && ` ${t('andMore', { n: uncovered.length - 6 })}`}
          </Alert>
        </div>
      )}
      {remove.isError && (
        <div className="mb-3">
          <Alert tone="bad">{policyError(remove.error)}</Alert>
        </div>
      )}
      {seasons.length === 0 ? (
        <p className="text-sm text-muted">{t('noSeasons')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {seasons.map((s) => (
            <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium" dir="ltr">
                    {s.code}
                  </span>{' '}
                  · {s.name}
                  {s.rates === 0 && (
                    <span className="ms-2">
                      <Badge tone="warn">{t('noRates')}</Badge>
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted">{s.periods.map(range).join(' · ')}</p>
              </div>
              {canWrite && (
                <div className="flex gap-1">
                  <Button variant="ghost" onClick={() => setEditing(s)}>
                    {t('edit')}
                  </Button>
                  {s.rates === 0 && (
                    <Button
                      variant="ghost"
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(t('deleteSeasonConfirm', { code: s.code })))
                          remove.mutate({ seasonId: s.id });
                      }}
                    >
                      {t('delete')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <SeasonDialog
          key={editing === 'add' ? 'add' : editing.id}
          vesselId={vesselId}
          season={editing === 'add' ? undefined : editing}
          onClose={() => setEditing(null)}
          onDone={refresh}
        />
      )}
    </Card>
  );
}

function SeasonDialog({
  vesselId,
  season,
  onClose,
  onDone,
}: {
  vesselId: string;
  season?: Season;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations('policies');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const policyError = usePolicyError();
  const [code, setCode] = useState(season?.code ?? '');
  const [name, setName] = useState(season?.name ?? '');
  const [periods, setPeriods] = useState(season?.periods ?? [{ from: '', to: '' }]);
  const add = useMutation(trpc.rates.addSeason.mutationOptions());
  const update = useMutation(trpc.rates.updateSeason.mutationOptions());
  const failed = add.error ?? update.error;
  const setPeriod = (i: number, patch: Partial<{ from: string; to: string }>) =>
    setPeriods((list) => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Dialog
      open
      onClose={onClose}
      title={season ? `${t('editSeason')} · ${season.code}` : t('addSeason')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            if (season)
              await update.mutateAsync({ seasonId: season.id, name: name.trim(), periods });
            else
              await add.mutateAsync({
                vesselId,
                code: code.trim().toUpperCase(),
                name: name.trim(),
                periods,
              });
            onDone();
            onClose();
          } catch {
            // Shown below.
          }
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('seasonName')} hint={t('seasonNameHint')}>
            <Input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label={t('code')} hint={season ? t('codeFixed') : t('seasonCodeHint')}>
            <Input
              required
              dir="ltr"
              className="uppercase"
              pattern="[A-Za-z][A-Za-z0-9_]{0,15}"
              disabled={Boolean(season)}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
        </div>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t('periods')}</legend>
          {periods.map((p, i) => (
            <div key={i} className="flex flex-wrap items-end gap-2">
              <Field label={t('from')}>
                <Input
                  type="date"
                  required
                  value={p.from}
                  onChange={(e) => setPeriod(i, { from: e.target.value })}
                />
              </Field>
              <Field label={t('to')}>
                <Input
                  type="date"
                  required
                  min={p.from || undefined}
                  value={p.to}
                  onChange={(e) => setPeriod(i, { to: e.target.value })}
                />
              </Field>
              {periods.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t('removePeriod')}
                  onClick={() => setPeriods((list) => list.filter((_, j) => j !== i))}
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
              onClick={() => setPeriods((list) => [...list, { from: '', to: '' }])}
            >
              + {t('addPeriod')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('periodsHelp')}</p>
        </fieldset>
        {failed && <Alert tone="bad">{policyError(failed)}</Alert>}
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
