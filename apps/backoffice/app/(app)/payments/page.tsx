import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { PaymentsScreen } from './payments-screen';

export default async function PaymentsPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('payments');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <PaymentsScreen canWrite={profile.permissions.includes('payments.write')} />
    </>
  );
}
