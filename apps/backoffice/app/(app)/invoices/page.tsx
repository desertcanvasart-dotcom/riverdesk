import { getTranslations } from 'next-intl/server';
import { LinkButton, PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { InvoicesScreen } from './invoices-screen';

export default async function InvoicesPage() {
  const profile = await (await serverCaller()).me.profile();
  const t = await getTranslations('invoices');
  const canFinance = profile.permissions.includes('finance');
  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          <>
            <LinkButton href="/invoices/statements">{t('statements')}</LinkButton>
            <LinkButton href="/invoices/receivables">{t('receivables')}</LinkButton>
            {canFinance && <LinkButton href="/invoices/settings">{t('settings')}</LinkButton>}
          </>
        }
      />
      <InvoicesScreen canFinance={canFinance} />
    </>
  );
}
