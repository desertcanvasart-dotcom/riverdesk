import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { PaymentsScreen } from './payments-screen';
import { PaymentsTabs } from './tabs';

export default async function PaymentsPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('payments');
  const finance = profile.permissions.includes('finance');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PaymentsTabs active="ledger" showReceipts={finance} />
      <PaymentsScreen canWrite={finance} />
    </>
  );
}
