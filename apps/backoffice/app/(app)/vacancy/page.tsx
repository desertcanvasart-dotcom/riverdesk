import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { VacancyScreen } from './vacancy-screen';

export default async function VacancyPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('vacancy');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <VacancyScreen
        vessels={vessels}
        canDocuments={profile.permissions.includes('documents.create')}
      />
    </>
  );
}
