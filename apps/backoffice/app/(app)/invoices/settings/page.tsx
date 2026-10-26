import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { PageHeader } from '../../../../components/ui';
import { serverCaller } from '../../../../server/caller';
import { FinanceSettingsScreen } from './finance-settings-screen';

export default async function FinanceSettingsPage() {
  const profile = await (await serverCaller()).me.profile();
  if (!profile.permissions.includes('finance')) redirect('/invoices');
  const t = await getTranslations('invoices');
  return (
    <>
      <PageHeader title={t('settingsTitle')} subtitle={t('settingsSubtitle')} />
      <FinanceSettingsScreen />
    </>
  );
}
