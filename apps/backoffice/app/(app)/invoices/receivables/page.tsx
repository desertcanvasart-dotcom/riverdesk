import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import { AgingScreen } from './aging-screen';

export default async function ReceivablesPage() {
  const t = await getTranslations('receivables');
  return (
    <>
      <PageHeader title={t('agingTitle')} subtitle={t('agingSubtitle')} />
      <AgingScreen />
    </>
  );
}
