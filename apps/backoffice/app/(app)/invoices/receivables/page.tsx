import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import { serverCaller } from '../../../../server/caller';
import { AgingScreen } from './aging-screen';

export default async function ReceivablesPage() {
  const profile = await (await serverCaller()).me.profile();
  if (!profile.permissions.includes('reports.money')) notFound();
  const t = await getTranslations('receivables');
  return (
    <>
      <PageHeader title={t('agingTitle')} subtitle={t('agingSubtitle')} />
      <AgingScreen />
    </>
  );
}
