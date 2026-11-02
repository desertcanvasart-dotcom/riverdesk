import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../../components/ui';
import { serverCaller } from '../../../../server/caller';
import { StatementScreen } from './statement-screen';

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ party?: string }>;
}) {
  const profile = await (await serverCaller()).me.profile();
  if (!profile.permissions.includes('reports.money')) notFound();
  const { party } = await searchParams;
  const t = await getTranslations('receivables');
  return (
    <>
      <PageHeader title={t('statementTitle')} subtitle={t('statementSubtitle')} />
      <StatementScreen initialParty={party && /^[0-9a-f-]{36}$/.test(party) ? party : ''} />
    </>
  );
}
