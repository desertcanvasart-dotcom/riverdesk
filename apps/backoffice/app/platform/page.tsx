import { getFormatter, getTranslations } from 'next-intl/server';
import { listPlatformCompanies } from '@vs/engine';
import { Badge, Card, Empty, PageHeader, Table, Td } from '../../components/ui';
import { backofficeDb } from '../../server/db';
import { AddCompanyForm, ReinviteForm } from './forms';
import { requirePlatformAdmin } from './guard';

export default async function PlatformPage() {
  const session = await requirePlatformAdmin();
  const t = await getTranslations('platform');
  const format = await getFormatter();
  const companies = await listPlatformCompanies(backofficeDb(), session.email);
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <div className="flex flex-col gap-5">
        <Card title={t('addTitle')}>
          <p className="mb-4 text-sm text-muted">{t('addHelp')}</p>
          <AddCompanyForm />
        </Card>
        <Card title={t('companies', { count: companies.length })}>
          {companies.length === 0 ? (
            <Empty>{t('none')}</Empty>
          ) : (
            <Table
              head={[
                t('name'),
                t('prefix'),
                t('owner'),
                t('staff'),
                t('vessels'),
                t('bookings'),
                t('created'),
              ]}
            >
              {companies.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <div className="font-medium">{c.name}</div>
                    <div className="text-xs text-muted" dir="ltr">
                      {c.slug}
                    </div>
                  </Td>
                  <Td>
                    <span dir="ltr">{c.bookingRefPrefix}</span>
                  </Td>
                  <Td>
                    {c.ownerActive ? (
                      <Badge tone="ok">{t('ownerActive')}</Badge>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <Badge tone={c.openInvitations > 0 ? 'warn' : 'bad'}>
                          {c.openInvitations > 0 ? t('ownerInvited') : t('ownerExpired')}
                        </Badge>
                        <ReinviteForm operatorId={c.id} name={c.name} />
                      </div>
                    )}
                  </Td>
                  <Td>{c.staff}</Td>
                  <Td>{c.vessels}</Td>
                  <Td>{c.bookings}</Td>
                  <Td>{format.dateTime(c.createdAt, { dateStyle: 'medium' })}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
