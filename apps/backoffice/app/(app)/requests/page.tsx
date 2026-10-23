import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { RequestsInbox } from './inbox';

export default async function RequestsPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('requests');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <RequestsInbox canWrite={profile.permissions.includes('bookings.write')} />
    </>
  );
}
