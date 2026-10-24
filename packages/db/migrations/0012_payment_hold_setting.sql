-- One place for the unpaid-booking hold (agreed 2026-10-25): a prepaid booking keeps its cabins for
-- the company's "Unpaid booking held" setting (operator_setting.payment_hold_hours). The payment
-- policy's own bank-transfer and card holds were never what staff set in Settings; drop them.

alter table vs.payment_policy
  drop column bank_transfer_hold_hours,
  drop column card_hold_minutes;
