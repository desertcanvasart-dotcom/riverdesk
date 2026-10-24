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
import { NILE_PORTS, usePickName } from '../../../lib/choices';
import { useTRPC } from '../../../lib/trpc';
import { useRouteError } from './route-errors';

export interface Port {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  active: boolean;
  usedBy: number;
}

/** The company's ports: shared by every ship and route. */
export function PortsCard({ ports, canWrite }: { ports: Port[]; canWrite: boolean }) {
  const t = useTranslations('routes');
  const locale = useLocale();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Port | 'add' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const usual = useMutation(
    trpc.routes.addUsualPorts.mutationOptions({
      onSuccess: (n) => {
        setNotice(t('usualAdded', { n }));
        void queryClient.invalidateQueries({ queryKey: trpc.routes.list.queryKey() });
      },
    }),
  );
  return (
    <Card
      title={t('ports')}
      actions={
        canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              disabled={usual.isPending}
              onClick={() => usual.mutate()}
              title={t('usualHint')}
            >
              {t('addUsual')}
            </Button>
            <Button variant="secondary" onClick={() => setEditing('add')}>
              + {t('addPort')}
            </Button>
          </div>
        )
      }
    >
      {notice && (
        <div className="mb-3">
          <Alert tone="ok">{notice}</Alert>
        </div>
      )}
      {ports.length === 0 ? (
        <p className="text-sm text-muted">{t('noPorts')}</p>
      ) : (
        <Table head={[t('code'), t('portName'), t('onRoutes'), '']}>
          {ports.map((p) => (
            <tr key={p.id} className={p.active ? '' : 'opacity-60'}>
              <Td>
                <span className="font-medium" dir="ltr">
                  {p.code}
                </span>
              </Td>
              <Td>
                {locale.startsWith('ar') ? p.nameAr : p.nameEn}
                {!p.active && (
                  <span className="ms-2">
                    <Badge>{t('retired')}</Badge>
                  </span>
                )}
              </Td>
              <Td>{p.usedBy > 0 ? t('stops', { n: p.usedBy }) : '—'}</Td>
              <Td>
                {canWrite && (
                  <Button variant="ghost" onClick={() => setEditing(p)}>
                    {t('edit')}
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      <PortDialog
        key={editing === 'add' ? 'add' : (editing?.id ?? 'closed')}
        port={editing}
        have={ports.map((p) => p.code)}
        onClose={() => setEditing(null)}
      />
    </Card>
  );
}

function PortDialog({
  port,
  have,
  onClose,
}: {
  port: Port | 'add' | null;
  /** Codes the company already has: not offered again. */
  have: string[];
  onClose: () => void;
}) {
  const pickName = usePickName();
  const [preset, setPreset] = useState<(typeof NILE_PORTS)[number] | null>(null);
  const t = useTranslations('routes');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const routeError = useRouteError();
  const options = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.routes.list.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.schedule.setup.queryKey() });
      onClose();
    },
  };
  const add = useMutation(trpc.routes.addPort.mutationOptions(options));
  const update = useMutation(trpc.routes.updatePort.mutationOptions(options));
  if (!port) return null;
  const editing = port === 'add' ? undefined : port;
  const failed = add.error ?? update.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `${t('editPort')} · ${editing.code}` : t('addPort')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const nameEn = String(form.get('nameEn')).trim();
          const nameAr = String(form.get('nameAr')).trim();
          if (editing)
            update.mutate({
              portId: editing.id,
              nameEn,
              nameAr,
              active: form.get('active') === 'on',
            });
          else add.mutate({ code: String(form.get('code')).trim().toUpperCase(), nameEn, nameAr });
        }}
      >
        {!editing && (
          <Field label={t('startFrom')} hint={t('startFromHint')}>
            <Select
              value={preset?.[0] ?? ''}
              onChange={(e) => setPreset(NILE_PORTS.find((x) => x[0] === e.target.value) ?? null)}
            >
              <option value="">{t('ownPort')}</option>
              {NILE_PORTS.filter((x) => !have.includes(x[0])).map((x) => (
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
              key={`en-${preset?.[0]}`}
              name="nameEn"
              required
              maxLength={100}
              dir="ltr"
              defaultValue={editing?.nameEn ?? preset?.[1]}
            />
          </Field>
          <Field label={t('nameAr')}>
            <Input
              key={`ar-${preset?.[0]}`}
              name="nameAr"
              required
              maxLength={100}
              dir="rtl"
              defaultValue={editing?.nameAr ?? preset?.[2]}
            />
          </Field>
        </div>
        <Field label={t('code')} hint={editing ? t('codeFixed') : t('portCodeHint')}>
          <Input
            key={`code-${preset?.[0]}`}
            name="code"
            required
            dir="ltr"
            className="uppercase"
            pattern="[A-Za-z][A-Za-z0-9_]{1,15}"
            defaultValue={editing?.code ?? preset?.[0]}
            disabled={Boolean(editing)}
          />
        </Field>
        {editing && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="active"
              className="size-4"
              defaultChecked={editing.active}
            />
            {t('portActive')}
          </label>
        )}
        {failed && <Alert tone="bad">{routeError(failed)}</Alert>}
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
