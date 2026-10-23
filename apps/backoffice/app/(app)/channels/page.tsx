import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { ChannelsScreen } from './channels-screen';

export default async function ChannelsPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('channels');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ChannelsScreen
        vessels={vessels}
        canChannels={profile.permissions.includes('channels.write')}
        canInventory={profile.permissions.includes('inventory.write')}
      />
    </>
  );
}
