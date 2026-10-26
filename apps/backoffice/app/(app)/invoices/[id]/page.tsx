import { serverCaller } from '../../../../server/caller';
import { InvoiceScreen } from './invoice-screen';

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const profile = await (await serverCaller()).me.profile();
  return (
    <InvoiceScreen
      invoiceId={id}
      canFinance={profile.permissions.includes('finance')}
      canDraft={profile.permissions.includes('bookings.write')}
    />
  );
}
