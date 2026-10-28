import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { PageHeader } from '../../../../components/ui';
import { serverCaller } from '../../../../server/caller';
import { PaymentsTabs } from '../tabs';
import { ReceiptsScreen } from './receipts-screen';

export default async function ReceiptsPage() {
  const profile = await (await serverCaller()).me.profile();
  if (!profile.permissions.includes('finance')) notFound();
  const t = await getTranslations('receipts');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PaymentsTabs active="receipts" showReceipts />
      <ReceiptsScreen />
    </>
  );
}
