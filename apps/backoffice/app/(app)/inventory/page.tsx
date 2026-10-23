import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { InventoryScreen } from './inventory-screen';

export default async function InventoryPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('inventory');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <InventoryScreen
        vessels={vessels}
        canWrite={profile.permissions.includes('inventory.write')}
      />
    </>
  );
}
