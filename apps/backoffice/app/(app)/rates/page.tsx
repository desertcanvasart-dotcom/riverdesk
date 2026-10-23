import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { RatesScreen } from './rates-screen';

export default async function RatesPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('rates');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <RatesScreen vessels={vessels} canWrite={profile.permissions.includes('rates.write')} />
    </>
  );
}
