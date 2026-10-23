/** Badge colour for a booking or payment status. */
export function statusTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'info' {
  switch (status) {
    case 'confirmed':
    case 'paid':
    case 'completed':
    case 'refunded':
      return 'ok';
    case 'held':
    case 'requested':
    case 'offered':
    case 'deposit_paid':
    case 'unpaid':
      return 'warn';
    case 'paid_unavailable':
    case 'refund_due':
      return 'bad';
    case 'cancelled':
    case 'declined':
    case 'expired':
      return 'neutral';
    default:
      return 'info';
  }
}
