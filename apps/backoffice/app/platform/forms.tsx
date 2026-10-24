'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { addCompany, reinviteOwner, type PlatformFormState } from './actions';

function Result({ state }: { state: PlatformFormState }) {
  const t = useTranslations('platform');
  if (!state) return null;
  if (state.ok)
    return <Alert tone="ok">{t('invited', { name: state.name, email: state.ownerEmail })}</Alert>;
  return <Alert tone="bad">{t(`errors.${state.error}`)}</Alert>;
}

export function AddCompanyForm() {
  const t = useTranslations('platform');
  const [state, action, busy] = useActionState(addCompany, null);
  // After an error React resets the form to its defaults: make those what was typed.
  const typed = (key: string) => (state && !state.ok ? state.values?.[key] : undefined);
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label={t('name')}>
        <Input name="name" defaultValue={typed('name')} required maxLength={200} />
      </Field>
      <Field label={t('slug')} hint={t('slugHint')}>
        <Input
          name="slug"
          defaultValue={typed('slug')}
          required
          pattern="[a-z0-9][a-z0-9\-]{1,62}"
          dir="ltr"
        />
      </Field>
      <Field label={t('prefix')} hint={t('prefixHint')}>
        <Input
          name="prefix"
          defaultValue={typed('prefix')}
          required
          pattern="[A-Za-z]{2,5}"
          dir="ltr"
          className="uppercase"
        />
      </Field>
      <Field label={t('locale')}>
        <Select name="locale" defaultValue={typed('locale') ?? 'ar'}>
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </Select>
      </Field>
      <Field label={t('ownerName')}>
        <Input name="ownerName" defaultValue={typed('ownerName')} required maxLength={200} />
      </Field>
      <Field label={t('ownerEmail')} hint={t('ownerEmailHint')}>
        <Input
          name="ownerEmail"
          type="email"
          defaultValue={typed('ownerEmail')}
          required
          dir="ltr"
        />
      </Field>
      <div className="flex flex-col gap-3 sm:col-span-2">
        <Result state={state} />
        <div>
          <Button type="submit" disabled={busy}>
            {t('add')}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ReinviteForm({ operatorId, name }: { operatorId: string; name: string }) {
  const t = useTranslations('platform');
  const [state, action, busy] = useActionState(reinviteOwner, null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-brand">{t('reinvite')}</summary>
      <form action={action} className="mt-2 flex min-w-64 flex-col gap-2">
        <input type="hidden" name="operatorId" value={operatorId} />
        <input type="hidden" name="company" value={name} />
        <Input name="ownerName" required placeholder={t('ownerName')} />
        <Input name="ownerEmail" type="email" required dir="ltr" placeholder={t('ownerEmail')} />
        <Result state={state} />
        <Button type="submit" variant="secondary" disabled={busy}>
          {t('sendInvite')}
        </Button>
      </form>
    </details>
  );
}
