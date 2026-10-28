-- Invoicing F3 (docs/invoicing-plan.md § 3.4 and § 6): receipts (money received from or paid back
-- to a billing party), allocations of receipts to invoices, and the link from the booking payment
-- ledger to them. Both new tables are append-only: a mistake is undone by a new, opposite row.

-- ---------------------------------------------------------------------------
-- Receipts. A receipt recorded from a booking (booking_id set) is that booking's money: it pays
-- that booking's invoices or is refunded to it. A receipt recorded from a party (an agency's
-- remittance) is the party's credit until it is allocated to invoices.
-- ---------------------------------------------------------------------------
create table vs.receipt (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  billing_party_id uuid not null,
  booking_id uuid,
  kind text not null check (kind in ('receipt', 'refund', 'reversal')),
  received_on date not null,
  -- In the currency received or paid out; negative for a refund, opposite the original for a reversal.
  amount bigint not null check (amount <> 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  method text not null check (method in ('cash', 'bank_transfer', 'card', 'agency_remittance', 'platform')),
  reference text not null check (length(reference) between 1 and 200),
  note text check (length(note) <= 500),
  credit_note_id uuid,
  reverses_receipt_id uuid,
  attachment bytea check (octet_length(attachment) <= 5242880),
  attachment_type text check (attachment_type in ('image/png', 'image/jpeg', 'application/pdf')),
  attachment_name text check (length(attachment_name) between 1 and 200),
  received_by uuid,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((kind = 'reversal') = (reverses_receipt_id is not null)),
  check (kind = 'reversal' or (kind = 'refund') = (amount < 0)),
  check (credit_note_id is null or kind = 'refund'),
  check ((attachment is null) = (attachment_type is null)),
  foreign key (operator_id, billing_party_id) references vs.billing_party (operator_id, id),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, credit_note_id) references vs.invoice (operator_id, id),
  foreign key (operator_id, reverses_receipt_id) references vs.receipt (operator_id, id),
  foreign key (operator_id, received_by) references vs.staff_user (operator_id, id)
);
create unique index receipt_reversal_idx on vs.receipt (reverses_receipt_id) where reverses_receipt_id is not null;
create index receipt_party_idx on vs.receipt (operator_id, billing_party_id, received_on);
create index receipt_booking_idx on vs.receipt (operator_id, booking_id) where booking_id is not null;

-- Only the attachment may be added or replaced after a receipt is recorded.
create function vs.receipt_guard() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.operator_id, new.billing_party_id, new.booking_id, new.kind, new.received_on, new.amount,
      new.currency, new.method, new.reference, new.note, new.credit_note_id, new.reverses_receipt_id,
      new.received_by, new.created_at)
     is distinct from
     (old.operator_id, old.billing_party_id, old.booking_id, old.kind, old.received_on, old.amount,
      old.currency, old.method, old.reference, old.note, old.credit_note_id, old.reverses_receipt_id,
      old.received_by, old.created_at)
  then
    raise exception 'a receipt cannot be changed; reverse it' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger receipt_guard before update on vs.receipt
  for each row execute function vs.receipt_guard();

-- ---------------------------------------------------------------------------
-- Allocations: how much of a receipt pays an invoice, per booking on it (booking_id null for
-- manual lines). Undone by a negative row, never edited.
-- ---------------------------------------------------------------------------
create table vs.allocation (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  receipt_id uuid not null,
  invoice_id uuid not null,
  booking_id uuid,
  -- In the receipt currency.
  amount bigint not null check (amount <> 0),
  -- The same in the invoice currency.
  invoice_amount bigint not null,
  -- 1 unit of the receipt currency = fx_rate units of the invoice currency, when they differ.
  fx_rate text check (fx_rate ~ '^[0-9]+(\.[0-9]{1,6})?$'),
  reason text not null check (reason in ('allocated', 'booking_payment', 'invoice_issued',
                                         'unallocated', 'credit_note', 'reversed')),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (operator_id, id),
  check (sign(amount) = sign(invoice_amount)),
  foreign key (operator_id, receipt_id) references vs.receipt (operator_id, id),
  foreign key (operator_id, invoice_id) references vs.invoice (operator_id, id),
  foreign key (operator_id, booking_id) references vs.booking (operator_id, id),
  foreign key (operator_id, created_by) references vs.staff_user (operator_id, id)
);
create index allocation_invoice_idx on vs.allocation (operator_id, invoice_id);
create index allocation_receipt_idx on vs.allocation (operator_id, receipt_id);
create index allocation_booking_idx on vs.allocation (operator_id, booking_id) where booking_id is not null;

-- ---------------------------------------------------------------------------
-- The booking ledger points at the receipt it came from and, when a party receipt was allocated
-- to an invoice, the allocation that wrote it. 'unallocated' is money of a party receipt taken
-- back off a booking (it returns to the party's credit).
-- ---------------------------------------------------------------------------
alter table vs.payment
  add column receipt_id uuid,
  add column allocation_id uuid,
  add foreign key (operator_id, receipt_id) references vs.receipt (operator_id, id),
  add foreign key (operator_id, allocation_id) references vs.allocation (operator_id, id);
alter table vs.payment drop constraint payment_kind_check;
alter table vs.payment add constraint payment_kind_check
  check (kind in ('deposit', 'balance', 'payment', 'refund', 'reversal', 'unallocated'));
alter table vs.payment drop constraint payment_check1;
alter table vs.payment add constraint payment_check1
  check ((kind in ('refund', 'reversal', 'unallocated')) = (amount < 0) or (kind = 'reversal'));
create index payment_receipt_idx on vs.payment (operator_id, receipt_id) where receipt_id is not null;

-- ---------------------------------------------------------------------------
-- Row-level security like every tenant table; the channel API and the worker write none of it.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['receipt', 'allocation'] loop
    execute format('alter table vs.%I enable row level security', t);
    execute format(
      'create policy tenant_isolation on vs.%I for all to vs_backoffice, vs_api, vs_worker
         using (operator_id = vs.current_operator_id())
         with check (operator_id = vs.current_operator_id())', t);
  end loop;
end
$$;
revoke delete on vs.receipt from vs_backoffice, vs_api, vs_worker;
revoke update, delete on vs.allocation from vs_backoffice, vs_api, vs_worker;
revoke insert, update, delete on vs.receipt, vs.allocation from vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- Existing data (§ 6): a billing party for every booking with payments, a receipt for every
-- payment, and the payments on bookings already invoiced allocated to those invoices.
-- ---------------------------------------------------------------------------

-- Agencies: one party per channel that bills its agency and has none yet.
insert into vs.billing_party (operator_id, kind, channel_id, name)
select ch.operator_id, 'agency', ch.id, left(ch.name, 200)
from vs.channel ch
where ch.type <> 'back_office'
  and exists (select from vs.booking b join vs.channel_contract cc on cc.id = b.contract_id
              where b.channel_id = ch.id and cc.payment_mode <> 'vessel_prepaid')
  and not exists (select from vs.billing_party p where p.channel_id = ch.id and p.kind = 'agency');

-- The party each paid booking bills: its agency, its guest party from an earlier invoice, or a new
-- guest party from the lead guest (the booking reference when it has no guest yet).
create temporary table f3_booking_party (booking_id uuid primary key, operator_id uuid, party_id uuid)
  on commit drop;
insert into f3_booking_party (booking_id, operator_id, party_id)
select b.id, b.operator_id,
       case when ch.type <> 'back_office' and cc.payment_mode <> 'vessel_prepaid'
         then (select p.id from vs.billing_party p where p.channel_id = b.channel_id and p.kind = 'agency')
         else (select i.billing_party_id from vs.invoice_line l join vs.invoice i on i.id = l.invoice_id
               join vs.billing_party p on p.id = i.billing_party_id
               where l.booking_id = b.id and p.kind = 'guest' order by i.created_at limit 1)
       end
from vs.booking b
join vs.channel ch on ch.id = b.channel_id
join vs.channel_contract cc on cc.id = b.contract_id
where exists (select from vs.payment pm where pm.booking_id = b.id);

do $$
declare
  r record;
  v_party uuid;
begin
  for r in
    select bp.booking_id, bp.operator_id, b.ref,
           g.first_name, g.last_name, g.phone, g.nationality
    from f3_booking_party bp
    join vs.booking b on b.id = bp.booking_id
    left join lateral (
      select first_name, last_name, phone, nationality from vs.guest
      where booking_id = bp.booking_id order by lead desc, created_at limit 1) g on true
    where bp.party_id is null
  loop
    insert into vs.billing_party (operator_id, kind, name, phone, country, eta_party_type)
    values (r.operator_id, 'guest',
            coalesce(left(r.first_name || ' ' || r.last_name, 200), r.ref),
            r.phone, r.nationality,
            case when r.nationality is null then null when r.nationality = 'EG' then 'P' else 'F' end)
    returning id into v_party;
    update f3_booking_party set party_id = v_party where booking_id = r.booking_id;
  end loop;
end
$$;

-- One receipt per payment, oldest first so a reversal finds its original's receipt.
do $$
declare
  p record;
  v_receipt uuid;
begin
  for p in
    select pm.*, bp.party_id from vs.payment pm
    join f3_booking_party bp on bp.booking_id = pm.booking_id
    order by pm.created_at, pm.id
  loop
    insert into vs.receipt (operator_id, billing_party_id, booking_id, kind, received_on, amount,
                            currency, method, reference, note, reverses_receipt_id, received_by,
                            created_at)
    values (p.operator_id, p.party_id, p.booking_id,
            case p.kind when 'refund' then 'refund' when 'reversal' then 'reversal' else 'receipt' end,
            p.received_on, p.amount, p.currency,
            case p.method
              when 'cash' then 'cash'
              when 'bank_transfer' then 'bank_transfer'
              when 'card_office' then 'card'
              when 'gateway' then 'card'
              when 'agent_remittance' then 'agency_remittance'
              else 'platform' end,
            p.reference, left(p.note, 500),
            (select o.receipt_id from vs.payment o where o.id = p.reverses_payment_id),
            case when p.actor_type = 'staff' then p.actor_id end,
            p.created_at)
    returning id into v_receipt;
    update vs.payment set receipt_id = v_receipt where id = p.id;
  end loop;
end
$$;

-- Payments on bookings already on an issued invoice pay that invoice: each booking's money up to
-- its share of the invoice, oldest receipt first.
do $$
declare
  inv record;
  bk record;
  rc record;
  v_open bigint;
  v_piece bigint;
  v_amount bigint;
begin
  for inv in
    select i.id, i.operator_id from vs.invoice i
    where i.type = 'invoice' and i.status in ('issued', 'partially_paid', 'paid')
    order by i.issued_at
  loop
    for bk in
      select l.booking_id,
             sum(case when l.tax_inclusive is not false then l.amount else l.amount + l.tax_amount end)
               - coalesce((select sum(case when cl.tax_inclusive is not false then cl.amount else cl.amount + cl.tax_amount end)
                           from vs.invoice_line cl join vs.invoice cn on cn.id = cl.invoice_id
                           where cn.credits_invoice_id = inv.id and cl.booking_id = l.booking_id), 0) as share
      from vs.invoice_line l
      where l.invoice_id = inv.id and l.booking_id is not null
      group by l.booking_id
    loop
      v_open := bk.share - coalesce((select sum(a.invoice_amount) from vs.allocation a
                                     where a.invoice_id = inv.id and a.booking_id = bk.booking_id), 0);
      -- What the booking paid and has not used on another invoice yet.
      v_open := least(v_open,
        (select b.amount_paid from vs.booking b where b.id = bk.booking_id)
        - coalesce((select sum(a.invoice_amount) from vs.allocation a where a.booking_id = bk.booking_id), 0));
      continue when v_open <= 0;
      for rc in
        select r.id, r.amount, pm.booking_amount, pm.fx_rate,
               r.amount - coalesce((select sum(a.amount) from vs.allocation a where a.receipt_id = r.id), 0) as free,
               pm.booking_amount - coalesce((select sum(a.invoice_amount) from vs.allocation a where a.receipt_id = r.id), 0) as free_inv
        from vs.receipt r join vs.payment pm on pm.receipt_id = r.id
        where r.booking_id = bk.booking_id and r.kind = 'receipt'
          and not exists (select from vs.receipt x where x.reverses_receipt_id = r.id)
        order by r.received_on, r.created_at
      loop
        exit when v_open <= 0;
        continue when rc.free_inv <= 0;
        v_piece := least(v_open, rc.free_inv);
        v_amount := case when v_piece = rc.free_inv then rc.free
                         else round(v_piece::numeric * rc.amount / rc.booking_amount)::bigint end;
        continue when v_amount <= 0;
        insert into vs.allocation (operator_id, receipt_id, invoice_id, booking_id, amount,
                                   invoice_amount, fx_rate, reason)
        values (inv.operator_id, rc.id, inv.id, bk.booking_id, v_amount, v_piece, rc.fx_rate,
                'invoice_issued');
        v_open := v_open - v_piece;
      end loop;
    end loop;
    update vs.invoice i set
      amount_paid = coalesce((select sum(a.invoice_amount) from vs.allocation a where a.invoice_id = i.id), 0)
    where i.id = inv.id;
    update vs.invoice i set status = case
        when i.amount_paid >= i.total - i.amount_credited then 'paid'
        when i.amount_paid > 0 then 'partially_paid'
        else 'issued' end
    where i.id = inv.id and i.status <> 'cancelled';
  end loop;
end
$$;
