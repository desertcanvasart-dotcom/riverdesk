import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { SettingsScreen } from './settings-screen';

export default async function SettingsPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('settings');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <SettingsScreen
        canWrite={profile.permissions.includes('settings.write')}
        selfId={profile.staffUserId}
      />
    </>
  );
}
