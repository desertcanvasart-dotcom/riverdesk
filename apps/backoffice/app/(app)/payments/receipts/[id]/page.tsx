import { notFound } from 'next/navigation';
import { serverCaller } from '../../../../../server/caller';
import { ReceiptScreen } from './receipt-screen';

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const profile = await (await serverCaller()).me.profile();
  if (!profile.permissions.includes('finance')) notFound();
  return <ReceiptScreen receiptId={id} />;
}
