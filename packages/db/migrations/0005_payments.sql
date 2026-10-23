-- Batch 4: payments (append-only ledger), payment status, paid_unavailable.

-- A booking that was paid after its cabins were gone: staff offer an alternative or refund.
alter table vs.booking drop constraint booking_status_check;
alter table vs.booking add constraint booking_status_check check (status in (
  'requested', 'held', 'offered', 'confirmed', 'declined', 'expired', 'cancelled', 'completed', 'paid_unavailable'
));

-- What is owed and what was received, in the booking currency. amount_paid is the sum of the
-- booking_amount of its payments (receipts positive, refunds and reversals negative).
alter table vs.booking
  add column payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'deposit_paid', 'paid', 'refund_due', 'refunded')),
  add column amount_paid bigint not null default 0,
  add column deposit_amount bigint not null default 0 check (deposit_amount >= 0),
  add column fees bigint not null default 0 check (fees >= 0),
  add column balance_due_date date;
create index booking_balance_due_idx on vs.booking (operator_id, balance_due_date) where status = 'confirmed';

-- The payment ledger: never edited or deleted; a correction is a new reversing entry.
create table vs.payment (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  booking_id uuid not null,
  kind text not null check (kind in ('deposit', 'balance', 'payment', 'refund', 'reversal')),
  method text not null check (method in ('bank_transfer', 'cash', 'card_office', 'agent_remittance', 'channel', 'gateway')),
  -- Amount in the currency it was received or paid out in; negative for refunds and reversals.
  amount bigint not null check (amount <> 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  -- 1 unit of `currency` = fx_rate units of the booking currency; set when the currencies differ.
  fx_rate text check (fx_rate ~ '^[0-9]+(\.[0-9]{1,6})?$'),
  -- The same amount in the booking currency (rounded half-up once).
  booking_amount bigint not null,
  reference text not null check (length(reference) between 1 and 200),
  received_on date not null,
  reverses_payment_id uuid,
  note text,
  actor_type text not null check (actor_type in ('staff', 'channel', 'system')),
  actor_id uuid,
  actor_label text,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((kind = 'reversal') = (reverses_payment_id is not null)),
  check ((kind in ('refund', 'reversal')) = (amount < 0) or (kind = 'reversal')),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, reverses_payment_id) references vs.payment (operator_id, id)
);
-- A payment can be reversed once.
create unique index payment_reversal_idx on vs.payment (reverses_payment_id) where reverses_payment_id is not null;
create index payment_booking_idx on vs.payment (operator_id, booking_id, created_at);

alter table vs.payment enable row level security;
create policy tenant_isolation on vs.payment for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke update, delete on vs.payment from vs_backoffice, vs_api, vs_worker;

-- Bookings of an agent that are on credit can be counted quickly for the limit check.
create index booking_channel_status_idx on vs.booking (operator_id, channel_id, status);
