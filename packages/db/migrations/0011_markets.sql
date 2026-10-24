-- Markets (agreed 2026-10-24): each company keeps its own list of markets (who a price is for),
-- with names in both languages and whether guests must show residency or ID at boarding.
-- Rate plans and quotes keep naming the market by its code, as before.

create table vs.market (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  code text not null check (code ~ '^[a-z][a-z_]{1,31}$'),
  name_en text not null check (length(name_en) between 1 and 100),
  name_ar text not null check (length(name_ar) between 1 and 100),
  needs_residency_proof boolean not null default true,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (operator_id, code)
);
alter table vs.market enable row level security;
create policy tenant_isolation on vs.market for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
create trigger market_touch before update on vs.market
  for each row execute function vs.touch_updated_at();

-- Every company starts with the two markets the system had built in.
create function vs.add_default_markets() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into vs.market (operator_id, code, name_en, name_ar, needs_residency_proof, sort_order)
  values (new.id, 'international', 'International', 'دولي', false, 10),
         (new.id, 'egyptian_resident', 'Egyptian resident', 'مقيم في مصر', true, 20)
  on conflict (operator_id, code) do nothing;
  return new;
end
$$;
create trigger operator_default_markets after insert on vs.operator
  for each row execute function vs.add_default_markets();

-- Existing companies: the two defaults, plus any market a rate plan already uses.
insert into vs.market (operator_id, code, name_en, name_ar, needs_residency_proof, sort_order)
select o.id, d.code, d.name_en, d.name_ar, d.proof, d.sort
from vs.operator o
cross join (values ('international', 'International', 'دولي', false, 10),
                   ('egyptian_resident', 'Egyptian resident', 'مقيم في مصر', true, 20))
  as d (code, name_en, name_ar, proof, sort)
on conflict (operator_id, code) do nothing;
insert into vs.market (operator_id, code, name_en, name_ar, needs_residency_proof, sort_order)
select distinct r.operator_id, r.market, r.market, r.market, r.market <> 'international', 100
from vs.rate_plan r
on conflict (operator_id, code) do nothing;
