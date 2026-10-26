/** Badge colour for an invoice's status. */
export function invoiceTone(status: string): 'ok' | 'warn' | 'bad' | 'neutral' | 'info' {
  switch (status) {
    case 'paid':
      return 'ok';
    case 'issued':
    case 'partially_paid':
      return 'warn';
    case 'cancelled':
      return 'neutral';
    default:
      return 'info';
  }
}
