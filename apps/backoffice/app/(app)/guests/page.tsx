import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { GuestsScreen } from './guests-screen';

export default async function GuestsPage({
  searchParams,
}: {
  searchParams: Promise<{ leg?: string }>;
}) {
  const { leg } = await searchParams;
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('guests');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <GuestsScreen
        vessels={vessels}
        initialLeg={leg && /^[0-9a-f-]{36}$/.test(leg) ? leg : null}
        canAssign={profile.permissions.includes('guests.assign')}
        canManifest={profile.permissions.includes('manifests')}
        canDocuments={profile.permissions.includes('documents.create')}
      />
    </>
  );
}
