'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { CapacityCard } from '../../../components/capacity-card';
import { Dialog } from '../../../components/dialog';
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
  cx,
} from '../../../components/ui';
import { ChoiceField } from '../../../components/choice-field';
import { useChoiceLabel, useChoices } from '../../../lib/choices';
import { useErrorText } from '../../../lib/errors';
import { useTRPC } from '../../../lib/trpc';

type VesselType = 'cruise_ship' | 'dahabiya' | 'steam';
interface Category {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  deck: string | null;
  view: string | null;
  bedConfig: string | null;
  maxAdults: number;
  maxOccupancy: number;
  extraBedAllowed: boolean;
  sortOrder: number;
  cabins: number;
}
interface Vessel {
  id: string;
  code: string;
  name: string;
  type: VesselType;
  maxGuests: number;
  categories: Category[];
  cabins: number;
  upcomingLegs: number;
}

/** The domain reason (code_taken, occupancy_in_use…) as text, else the usual error text. */
function useFleetError() {
  const t = useTranslations('fleet');
  const errorText = useErrorText();
  return (error: unknown) => {
    const details = (
      error as { data?: { domainDetails?: { reason?: string; bookings?: number } } } | null
    )?.data?.domainDetails;
    if (details?.reason === 'code_taken') return t('errors.codeTaken');
    if (details?.reason === 'occupancy_in_use')
      return t('errors.occupancyInUse', { n: details.bookings ?? 0 });
    return errorText(error);
  };
}

export function FleetScreen({
  canEditFleet,
  canEditCabins,
}: {
  canEditFleet: boolean;
  canEditCabins: boolean;
}) {
  const t = useTranslations('fleet');
  const tc = useTranslations('common');
  const locale = useLocale();
  const trpc = useTRPC();
  const fleet = useQuery(trpc.fleet.list.queryOptions());
  const choiceLabel = useChoiceLabel();
  const [picked, setPicked] = useState<string | null>(null);
  const [vesselDialog, setVesselDialog] = useState<'add' | 'edit' | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<Category | 'add' | null>(null);
  const vessels = fleet.data ?? [];
  const vessel = vessels.find((v) => v.id === picked) ?? vessels[0];

  if (fleet.isLoading) return <Empty>{tc('loading')}</Empty>;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {vessels.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setPicked(v.id)}
            className={cx(
              'min-h-10 rounded-lg border px-4 text-sm',
              v.id === vessel?.id
                ? 'border-brand bg-brand text-brand-ink'
                : 'border-line bg-surface hover:bg-line/40',
            )}
          >
            {v.name}
          </button>
        ))}
        {canEditFleet && (
          <Button variant="ghost" onClick={() => setVesselDialog('add')}>
            + {t('addShip')}
          </Button>
        )}
      </div>

      {!vessel ? (
        <Card>
          <Empty>{canEditFleet ? t('noShips') : t('noShipsReadOnly')}</Empty>
        </Card>
      ) : (
        <>
          <Card
            title={vessel.name}
            actions={
              canEditFleet && (
                <Button variant="secondary" onClick={() => setVesselDialog('edit')}>
                  {t('edit')}
                </Button>
              )
            }
          >
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label={t('code')} value={<span dir="ltr">{vessel.code}</span>} />
              <Stat label={t('type')} value={t(`types.${vessel.type}`)} />
              <Stat label={t('maxGuests')} value={vessel.maxGuests} />
              <Stat
                label={t('cabinsBeds')}
                value={t('cabinsBedsValue', {
                  cabins: vessel.cabins,
                  beds: vessel.categories.reduce((n, c) => n + c.cabins * c.maxOccupancy, 0),
                })}
              />
            </dl>
            <NextStep vessel={vessel} />
          </Card>

          <Card
            title={t('categories')}
            actions={
              canEditFleet && (
                <Button variant="secondary" onClick={() => setCategoryDialog('add')}>
                  + {t('addCategory')}
                </Button>
              )
            }
          >
            {vessel.categories.length === 0 ? (
              <p className="text-sm text-muted">{t('noCategories')}</p>
            ) : (
              <Table
                head={[t('code'), t('categoryName'), t('details'), t('guests'), t('cabins'), '']}
              >
                {vessel.categories.map((c) => (
                  <tr key={c.id}>
                    <Td>
                      <span className="font-medium" dir="ltr">
                        {c.code}
                      </span>
                    </Td>
                    <Td>{locale.startsWith('ar') ? c.nameAr : c.nameEn}</Td>
                    <Td className="text-muted">
                      {[
                        choiceLabel('deck', c.deck),
                        choiceLabel('view', c.view),
                        choiceLabel('bed', c.bedConfig),
                      ]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </Td>
                    <Td>
                      {t('guestsValue', { adults: c.maxAdults, max: c.maxOccupancy })}
                      {c.extraBedAllowed && (
                        <span className="ms-1">
                          <Badge tone="info">{t('extraBed')}</Badge>
                        </span>
                      )}
                    </Td>
                    <Td>{c.cabins}</Td>
                    <Td>
                      {canEditFleet && (
                        <Button variant="ghost" onClick={() => setCategoryDialog(c)}>
                          {t('edit')}
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>

          {vessel.categories.length > 0 && (
            <CapacityCard
              vesselId={vessel.id}
              categories={vessel.categories}
              canWrite={canEditCabins}
            />
          )}
        </>
      )}

      <VesselDialog
        mode={vesselDialog}
        vessel={vesselDialog === 'edit' ? vessel : undefined}
        onClose={() => setVesselDialog(null)}
        onCreated={(id) => setPicked(id)}
      />
      {vessel && (
        <CategoryDialog
          vesselId={vessel.id}
          category={categoryDialog}
          nextSort={(vessel.categories.at(-1)?.sortOrder ?? 0) + 10}
          decks={vessel.categories.map((c) => c.deck)}
          onClose={() => setCategoryDialog(null)}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}

/** What a new ship still needs before it can be sold, one step at a time. */
function NextStep({ vessel }: { vessel: Vessel }) {
  const t = useTranslations('fleet');
  const step =
    vessel.categories.length === 0
      ? 'categories'
      : vessel.cabins === 0
        ? 'cabins'
        : vessel.upcomingLegs === 0
          ? 'schedule'
          : null;
  if (!step) return null;
  return (
    <div className="mt-4">
      <Alert tone="info">
        {t(`next.${step}`)}{' '}
        {step === 'schedule' && (
          <Link href="/schedule" className="font-medium underline">
            {t('next.scheduleLink')}
          </Link>
        )}
      </Alert>
    </div>
  );
}

function VesselDialog({
  mode,
  vessel,
  onClose,
  onCreated,
}: {
  mode: 'add' | 'edit' | null;
  vessel?: Vessel;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('fleet');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fleetError = useFleetError();
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.fleet.list.queryKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.book.vessels.queryKey() });
  };
  const add = useMutation(
    trpc.fleet.addVessel.mutationOptions({
      onSuccess: (v) => {
        done();
        onCreated(v.id);
        onClose();
      },
    }),
  );
  const update = useMutation(
    trpc.fleet.updateVessel.mutationOptions({
      onSuccess: () => {
        done();
        onClose();
      },
    }),
  );
  if (!mode) return null;
  const failed = add.error ?? update.error;
  return (
    <Dialog open onClose={onClose} title={mode === 'add' ? t('addShip') : t('editShip')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const name = String(form.get('name')).trim();
          const type = String(form.get('type')) as VesselType;
          const maxGuests = Number(form.get('maxGuests'));
          if (mode === 'add')
            add.mutate({
              code: String(form.get('code')).trim().toUpperCase(),
              name,
              type,
              maxGuests,
            });
          else if (vessel) update.mutate({ vesselId: vessel.id, name, type, maxGuests });
        }}
      >
        <Field label={t('shipName')}>
          <Input name="name" required maxLength={200} defaultValue={vessel?.name} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('code')} hint={mode === 'add' ? t('shipCodeHint') : t('codeFixed')}>
            <Input
              name="code"
              required
              dir="ltr"
              className="uppercase"
              pattern="[A-Za-z][A-Za-z0-9_]{1,15}"
              defaultValue={vessel?.code}
              disabled={mode === 'edit'}
            />
          </Field>
          <Field label={t('type')}>
            <Select name="type" defaultValue={vessel?.type ?? 'cruise_ship'}>
              {(['cruise_ship', 'dahabiya', 'steam'] as const).map((type) => (
                <option key={type} value={type}>
                  {t(`types.${type}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t('maxGuests')} hint={t('maxGuestsHint')}>
          <Input
            name="maxGuests"
            type="number"
            required
            min={1}
            max={1000}
            defaultValue={vessel?.maxGuests}
          />
        </Field>
        {failed && <Alert tone="bad">{fleetError(failed)}</Alert>}
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

function CategoryDialog({
  vesselId,
  category,
  nextSort,
  decks,
  onClose,
}: {
  vesselId: string;
  category: Category | 'add' | null;
  nextSort: number;
  /** Deck names this ship already uses, offered next to the usual ones. */
  decks: (string | null)[];
  onClose: () => void;
}) {
  const deckChoices = useChoices('deck', decks);
  const viewChoices = useChoices('view');
  const bedChoices = useChoices('bed');
  const t = useTranslations('fleet');
  const tc = useTranslations('common');
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fleetError = useFleetError();
  const [limitError, setLimitError] = useState(false);
  const options = {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: trpc.fleet.list.queryKey() });
      void queryClient.invalidateQueries({ queryKey: trpc.book.vessels.queryKey() });
      onClose();
    },
  };
  const add = useMutation(trpc.fleet.addCategory.mutationOptions(options));
  const update = useMutation(trpc.fleet.updateCategory.mutationOptions(options));
  if (!category) return null;
  const editing = category === 'add' ? undefined : category;
  const failed = add.error ?? update.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={editing ? `${t('editCategory')} · ${editing.code}` : t('addCategory')}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const text = (key: string) => String(form.get(key) ?? '').trim();
          const maxAdults = Number(form.get('maxAdults'));
          const maxOccupancy = Number(form.get('maxOccupancy'));
          setLimitError(maxOccupancy < maxAdults);
          if (maxOccupancy < maxAdults) return;
          const fields = {
            nameEn: text('nameEn'),
            nameAr: text('nameAr'),
            deck: text('deck') || undefined,
            view: text('view') || undefined,
            bedConfig: text('bedConfig') || undefined,
            maxAdults,
            maxOccupancy,
            extraBedAllowed: form.get('extraBed') === 'on',
            sortOrder: Number(form.get('sortOrder')),
          };
          if (editing) update.mutate({ categoryId: editing.id, ...fields });
          else add.mutate({ vesselId, code: text('code').toUpperCase(), ...fields });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('nameEn')}>
            <Input
              name="nameEn"
              required
              maxLength={100}
              dir="ltr"
              defaultValue={editing?.nameEn}
            />
          </Field>
          <Field label={t('nameAr')}>
            <Input
              name="nameAr"
              required
              maxLength={100}
              dir="rtl"
              defaultValue={editing?.nameAr}
            />
          </Field>
          <Field label={t('code')} hint={editing ? t('codeFixed') : t('categoryCodeHint')}>
            <Input
              name="code"
              required
              dir="ltr"
              className="uppercase"
              pattern="[A-Za-z][A-Za-z0-9_]{0,15}"
              defaultValue={editing?.code}
              disabled={Boolean(editing)}
            />
          </Field>
          <Field label={t('sortOrder')} hint={t('sortOrderHint')}>
            <Input
              name="sortOrder"
              type="number"
              min={0}
              max={999}
              required
              defaultValue={editing?.sortOrder ?? nextSort}
            />
          </Field>
          <Field label={t('maxAdults')}>
            <Input
              name="maxAdults"
              type="number"
              min={1}
              max={10}
              required
              defaultValue={editing?.maxAdults ?? 2}
            />
          </Field>
          <Field
            label={t('maxOccupancy')}
            hint={t('maxOccupancyHint')}
            error={limitError ? t('errors.limit') : undefined}
          >
            <Input
              name="maxOccupancy"
              type="number"
              min={1}
              max={12}
              required
              defaultValue={editing?.maxOccupancy ?? 3}
            />
          </Field>
          <Field label={t('deck')}>
            <ChoiceField
              name="deck"
              maxLength={50}
              choices={deckChoices}
              defaultValue={editing?.deck ?? ''}
            />
          </Field>
          <Field label={t('view')}>
            <ChoiceField
              name="view"
              maxLength={50}
              choices={viewChoices}
              defaultValue={editing?.view ?? ''}
            />
          </Field>
          <Field label={t('bedConfig')}>
            <ChoiceField
              name="bedConfig"
              maxLength={50}
              choices={bedChoices}
              defaultValue={editing?.bedConfig ?? ''}
            />
          </Field>
          <label className="flex min-h-10 items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              name="extraBed"
              className="size-4"
              defaultChecked={editing?.extraBedAllowed ?? false}
            />
            {t('extraBedAllowed')}
          </label>
        </div>
        {failed && <Alert tone="bad">{fleetError(failed)}</Alert>}
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
