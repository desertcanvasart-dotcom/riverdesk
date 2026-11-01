-- A credit note line names the invoice line it credits, so each line can be credited at most up
-- to its own amount across all credit notes (not only the invoice in total).
alter table vs.invoice_line add column credits_line_id uuid;
alter table vs.invoice_line add constraint invoice_line_credits_line_fk
  foreign key (operator_id, credits_line_id) references vs.invoice_line (operator_id, id);
create index invoice_line_credits_idx on vs.invoice_line (operator_id, credits_line_id)
  where credits_line_id is not null;

-- Existing credit notes are issued, so their lines are guarded; link them with the guard off.
alter table vs.invoice_line disable trigger invoice_line_guard;

-- A whole-invoice credit copies the invoice's lines in order: same seq, same kind.
update vs.invoice_line cl
set credits_line_id = l.id
from vs.invoice cn, vs.invoice_line l
where cn.id = cl.invoice_id
  and cn.type = 'credit_note'
  and l.invoice_id = cn.credits_invoice_id
  and l.seq = cl.seq
  and l.kind = cl.kind
  and l.booking_id is not distinct from cl.booking_id
  and l.description_en = cl.description_en
  and (select count(*) from vs.invoice_line x where x.invoice_id = cn.id)
    = (select count(*) from vs.invoice_line x where x.invoice_id = cn.credits_invoice_id);

-- A partial credit: the one line of the credited invoice it can only have come from. A line
-- that matches several stays unlinked; the invoice total still caps it.
update vs.invoice_line cl
set credits_line_id = (
  select l.id from vs.invoice_line l
  where l.invoice_id = cn.credits_invoice_id
    and l.kind = cl.kind
    and l.booking_id is not distinct from cl.booking_id
    and l.booking_cabin_id is not distinct from cl.booking_cabin_id
    and l.description_en = cl.description_en
    and l.tax_rate_id is not distinct from cl.tax_rate_id)
from vs.invoice cn
where cn.id = cl.invoice_id
  and cn.type = 'credit_note'
  and cl.credits_line_id is null
  and (select count(*) from vs.invoice_line l
       where l.invoice_id = cn.credits_invoice_id
         and l.kind = cl.kind
         and l.booking_id is not distinct from cl.booking_id
         and l.booking_cabin_id is not distinct from cl.booking_cabin_id
         and l.description_en = cl.description_en
         and l.tax_rate_id is not distinct from cl.tax_rate_id) = 1;

alter table vs.invoice_line enable trigger invoice_line_guard;
