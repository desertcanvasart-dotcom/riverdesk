-- Batch 6: cabin assignment per leg, rendered documents, voucher details.

-- A booked cabin is assigned a physical cabin on each leg it sails. Assignment lives on the
-- booking line (one row per booked cabin per leg), so a physical cabin can never be given to two
-- guests on the same leg, and a released line (cancellation, amendment) frees it by itself.
alter table vs.booking_line
  add column assigned_cabin_id uuid,
  add constraint booking_line_assigned_cabin_fk
    foreign key (operator_id, assigned_cabin_id) references vs.cabin (operator_id, id);
create unique index booking_line_cabin_idx on vs.booking_line (leg_id, assigned_cabin_id)
  where status = 'confirmed' and assigned_cabin_id is not null;

-- What the voucher needs that the schedule does not hold.
alter table vs.operator_setting
  add column emergency_phone text check (length(emergency_phone) <= 50),
  add column voucher_note_en text check (length(voucher_note_en) <= 2000),
  add column voucher_note_ar text check (length(voucher_note_ar) <= 2000);

-- Rendered documents (PDF, XLSX, PNG). Requested by staff, rendered by the worker, downloaded
-- once ready. Manifests carry passport numbers: they expire after a day; others after a week.
create table vs.document (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  kind text not null check (kind in (
    'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
    'manifest', 'rooming_list', 'vacancy_sheet')),
  format text not null check (format in ('pdf', 'xlsx', 'png')),
  locale text not null check (locale in ('ar', 'en')),
  -- The agent version of a booking document leaves prices out.
  variant text not null default 'full' check (variant in ('full', 'agent')),
  entity text not null check (entity in ('booking', 'leg', 'vessel')),
  entity_id uuid not null,
  params jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  filename text,
  content_type text,
  content bytea,
  error text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (operator_id, id),
  check ((status = 'ready') = (content is not null)),
  foreign key (operator_id, requested_by) references vs.staff_user (operator_id, id)
);
create index document_entity_idx on vs.document (operator_id, entity, entity_id, created_at desc);
create index document_expiry_idx on vs.document (expires_at);
alter table vs.document enable row level security;
create policy tenant_isolation on vs.document for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
create trigger document_touch before update on vs.document
  for each row execute function vs.touch_updated_at();
-- Staff request and read; only the worker renders, and only the worker prunes expired ones.
revoke update, delete on vs.document from vs_backoffice, vs_api;

-- Lets the back office queue a render without any access to the job queue itself: one task on
-- the allow-list, and only for a pending document of the caller's own company.
create function vs.enqueue_document(p_document_id uuid)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not exists (
    select from vs.document d
    where d.id = p_document_id and d.status = 'pending'
      and d.operator_id = vs.current_operator_id()
  ) then
    raise exception 'document % is not a pending document of this company', p_document_id
      using errcode = 'P0002';
  end if;
  perform graphile_worker.add_job(
    'render_document',
    json_build_object('operator_id', vs.current_operator_id(), 'document_id', p_document_id),
    job_key => 'document:' || p_document_id::text,
    max_attempts => 3);
end
$$;
revoke execute on function vs.enqueue_document(uuid) from public, vs_api, vs_worker;
