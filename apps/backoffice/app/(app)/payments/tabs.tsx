import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { cx } from '../../../components/ui';

/** Booking payments | Receipts (receipts are finance only). */
export async function PaymentsTabs({
  active,
  showReceipts,
}: {
  active: 'ledger' | 'receipts';
  showReceipts: boolean;
}) {
  const t = await getTranslations('receipts');
  if (!showReceipts) return null;
  const tab = (key: 'ledger' | 'receipts', href: string, label: string) => (
    <Link
      href={href}
      aria-current={active === key ? 'page' : undefined}
      className={cx(
        'border-b-2 px-3 py-2 text-sm',
        active === key ? 'border-brand font-medium text-brand' : 'border-transparent text-muted',
      )}
    >
      {label}
    </Link>
  );
  return (
    <nav className="mb-4 flex gap-1 border-b border-line">
      {tab('ledger', '/payments', t('tabLedger'))}
      {tab('receipts', '/payments/receipts', t('tabReceipts'))}
    </nav>
  );
}
