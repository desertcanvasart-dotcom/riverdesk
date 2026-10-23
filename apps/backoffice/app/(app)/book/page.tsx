import { getTranslations } from 'next-intl/server';
import { PageHeader } from '../../../components/ui';
import { serverCaller } from '../../../server/caller';
import { BookForm } from './book-form';

export default async function BookPage() {
  const caller = await serverCaller();
  const [vessels, profile] = await Promise.all([caller.book.vessels(), caller.me.profile()]);
  const t = await getTranslations('book');
  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <BookForm vessels={vessels} canBook={profile.permissions.includes('bookings.write')} />
    </>
  );
}
