import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { AnalyticsScreen } from './analytics-screen';

export default async function AnalyticsPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('analytics');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <AnalyticsScreen
        vessels={vessels.map((v) => ({ id: v.id, name: v.name }))}
        canMoney={profile.permissions.includes('analytics.money')}
      />
    </>
  );
}
