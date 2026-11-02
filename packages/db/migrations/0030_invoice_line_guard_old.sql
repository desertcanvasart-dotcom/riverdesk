-- An issued invoice's lines cannot be moved off it either: on UPDATE the guard checks the
-- invoice the line comes from as well as the one it goes to (before, only the new one).
create or replace function vs.invoice_line_guard() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select i.status into v_status from vs.invoice i where i.id = old.invoice_id;
    -- A cascade from deleting a draft finds no parent left; that is allowed.
    if v_status is not null and v_status <> 'draft' then
      raise exception 'lines of an issued invoice cannot change' using errcode = '42501';
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select i.status into v_status from vs.invoice i where i.id = new.invoice_id;
    if v_status is not null and v_status <> 'draft' then
      raise exception 'lines of an issued invoice cannot change' using errcode = '42501';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;
