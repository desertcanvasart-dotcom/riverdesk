import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import { serverCaller } from '../../../../server/caller';
import { ReportsScreen } from './reports-screen';

export default async function FinanceReportsPage() {
  const caller = await serverCaller();
  const [profile, vessels, channels] = await Promise.all([
    caller.me.profile(),
    caller.book.vessels(),
    caller.channels.list(),
  ]);
  const t = await getTranslations('financeReports');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <ReportsScreen
        canFinance={profile.permissions.includes('finance')}
        vessels={vessels.map((v) => ({ id: v.id, name: v.name }))}
        channels={channels.map((c) => ({ id: c.id, name: c.name }))}
      />
    </>
  );
}
