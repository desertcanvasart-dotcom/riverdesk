import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { ScheduleScreen } from './schedule-screen';

export default async function SchedulePage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('schedule');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ScheduleScreen vessels={vessels} canWrite={profile.permissions.includes('schedule.write')} />
    </>
  );
}
