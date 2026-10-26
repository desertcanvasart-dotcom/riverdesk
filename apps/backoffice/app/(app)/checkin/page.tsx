import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { CheckinScreen } from './checkin-screen';

export default async function CheckinPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('checkin');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <CheckinScreen
        canWrite={profile.permissions.includes('checkin.write')}
        canPassports={profile.permissions.includes('manifests')}
        canFleet={profile.permissions.includes('fleet.write')}
        onboard={profile.role === 'onboard'}
      />
    </>
  );
}
