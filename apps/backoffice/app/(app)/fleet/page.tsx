import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { FleetScreen } from './fleet-screen';

export default async function FleetPage() {
  const caller = await serverCaller();
  const profile = await caller.me.profile();
  const t = await getTranslations('fleet');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <FleetScreen
        canEditFleet={profile.permissions.includes('fleet.write')}
        canEditCabins={profile.permissions.includes('inventory.write')}
      />
    </>
  );
}
