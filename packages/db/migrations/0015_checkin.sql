-- Batch D2 (agreed 2026-10-26): check-in. Guest details the reception and the police list need,
-- check-in marks per booked cabin and departure, an on-board staff role limited to one vessel,
-- and the vessel's on-board email for the check-in pack.

-- ---------------------------------------------------------------------------
-- Guest details for check-in. All optional. Visa numbers and medical notes are encrypted like
-- passport numbers (rule 9); everything personal here is erased with the passport after
-- disembarkation (operator_setting.passport_retention_days).
-- ---------------------------------------------------------------------------
alter table vs.guest
  add column title text check (title in ('mr', 'mrs', 'ms', 'miss', 'dr')),
  add column gender text check (gender in ('female', 'male')),
  add column passport_country char(2) check (passport_country ~ '^[A-Z]{2}$'),
  add column passport_issued_on date,
  add column passport_expires_on date,
  add column place_of_birth text check (length(place_of_birth) between 1 and 100),
  add column visa_type text check (visa_type in ('e_visa', 'on_arrival', 'sticker', 'residence', 'not_required')),
  add column visa_ciphertext bytea,
  add column visa_key_id text,
  add column arrival_date date,
  add column arrival_flight text check (length(arrival_flight) between 1 and 20),
  add column arrival_port text check (length(arrival_port) between 1 and 100),
  add column phone text check (length(phone) between 3 and 30),
  add column emergency_name text check (length(emergency_name) between 1 and 100),
  add column emergency_phone text check (length(emergency_phone) between 3 and 30),
  add column dietary text[] not null default '{}' check (dietary <@ array[
    'vegetarian', 'vegan', 'halal', 'kosher', 'gluten_free', 'lactose_free', 'no_pork',
    'no_seafood', 'diabetic']::text[]),
  add column allergies text check (length(allergies) between 1 and 300),
  add column medical_ciphertext bytea,
  add column medical_key_id text,
  add column occasion text check (occasion in ('birthday', 'honeymoon', 'anniversary', 'other')),
  add column occasion_date date,
  add constraint guest_visa_key_check check ((visa_ciphertext is null) = (visa_key_id is null)),
  add constraint guest_medical_key_check check ((medical_ciphertext is null) = (medical_key_id is null)),
  add constraint guest_passport_dates_check
    check (passport_expires_on is null or passport_issued_on is null or passport_expires_on > passport_issued_on);

-- ---------------------------------------------------------------------------
-- Check-in marks: one row per booked cabin boarding a departure. Kept on the cabin, not the
-- guest, because a booking's guests are replaced as a list whenever they are edited.
-- ---------------------------------------------------------------------------
create table vs.checkin (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  leg_id uuid not null,
  booking_cabin_id uuid not null,
  passports_seen boolean not null default false,
  cards_signed boolean not null default false,
  key_handed boolean not null default false,
  checked_in_at timestamptz,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  unique (leg_id, booking_cabin_id),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id),
  foreign key (operator_id, booking_cabin_id) references vs.booking_cabin (operator_id, id),
  foreign key (operator_id, updated_by) references vs.staff_user (operator_id, id)
);
create index checkin_leg_idx on vs.checkin (operator_id, leg_id);
create trigger checkin_touch before update on vs.checkin
  for each row execute function vs.touch_updated_at();
alter table vs.checkin enable row level security;
create policy tenant_isolation on vs.checkin for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.checkin from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- On-board staff: a login limited to one vessel's departures, with no prices or payments.
-- ---------------------------------------------------------------------------
alter table vs.staff_user drop constraint staff_user_role_check;
alter table vs.staff_user
  add column vessel_id uuid,
  add constraint staff_user_role_check
    check (role in ('owner', 'reservations', 'finance', 'read_only', 'onboard')),
  add constraint staff_user_vessel_check check ((role = 'onboard') = (vessel_id is not null)),
  add constraint staff_user_vessel_fk foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id);

alter table vs.staff_invitation drop constraint staff_invitation_role_check;
alter table vs.staff_invitation
  add column vessel_id uuid,
  add constraint staff_invitation_role_check
    check (role in ('owner', 'reservations', 'finance', 'read_only', 'onboard')),
  add constraint staff_invitation_vessel_check check ((role = 'onboard') = (vessel_id is not null)),
  add constraint staff_invitation_vessel_fk foreign key (operator_id, vessel_id) references vs.vessel (operator_id, id);

-- The session lookup and the first-sign-in claim now carry the vessel. Same names, same callers.
drop function vs.resolve_staff(uuid);
create function vs.resolve_staff(p_auth_user_id uuid)
returns table (staff_user_id uuid, operator_id uuid, role text, vessel_id uuid)
language sql stable security definer
set search_path = ''
as $$
  select s.id, s.operator_id, s.role, s.vessel_id
  from vs.staff_user s
  where s.auth_user_id = p_auth_user_id and s.active
$$;
revoke execute on function vs.resolve_staff(uuid) from public, vs_api, vs_worker;

drop function vs.claim_staff_invitation(uuid, text);
create function vs.claim_staff_invitation(p_auth_user_id uuid, p_email text)
returns table (staff_user_id uuid, operator_id uuid, role text, vessel_id uuid)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_invitation vs.staff_invitation;
  v_staff_id uuid;
begin
  if exists (select from vs.staff_user s where s.auth_user_id = p_auth_user_id) then
    return query select s.id, s.operator_id, s.role, s.vessel_id from vs.staff_user s
      where s.auth_user_id = p_auth_user_id and s.active;
    return;
  end if;
  select * into v_invitation from vs.staff_invitation i
  where lower(i.email) = lower(p_email) and i.accepted_at is null and i.expires_at > now()
  for update;
  if not found then
    return;
  end if;
  insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role, vessel_id)
  values (v_invitation.operator_id, p_auth_user_id, lower(p_email), v_invitation.display_name,
          v_invitation.role, v_invitation.vessel_id)
  returning id into v_staff_id;
  update vs.staff_invitation set accepted_at = now(), staff_user_id = v_staff_id where id = v_invitation.id;
  insert into vs.audit_log (operator_id, actor_type, actor_id, actor_label, action, entity, entity_id, diff)
  values (v_invitation.operator_id, 'staff', v_staff_id, 'first sign-in', 'staff_invitation.accepted',
          'staff_user', v_staff_id, jsonb_build_object('role', jsonb_build_object('from', null, 'to', v_invitation.role)));
  return query select v_staff_id, v_invitation.operator_id, v_invitation.role, v_invitation.vessel_id;
end
$$;
revoke execute on function vs.claim_staff_invitation(uuid, text) from public, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- The check-in pack (the check-in file and the embarkation sheet): emailed to the vessel's
-- on-board address N hours before a departure (off while checkin_pack_hours is null), or sent
-- with one button. Each send is a row the worker picks up; the scheduled one exists once per
-- departure, so the job never sends it twice.
-- ---------------------------------------------------------------------------
alter table vs.vessel
  add column onboard_email text check (onboard_email ~ '^[^@\s]+@[^@\s]+$'),
  add column checkin_pack_hours integer check (checkin_pack_hours between 1 and 72),
  add constraint vessel_checkin_pack_check check (checkin_pack_hours is null or onboard_email is not null);

create table vs.checkin_pack_send (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  leg_id uuid not null,
  sent_to text not null check (sent_to ~ '^[^@\s]+@[^@\s]+$'),
  trigger text not null check (trigger in ('scheduled', 'button')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error text,
  requested_by uuid,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((status = 'sent') = (sent_at is not null)),
  foreign key (operator_id, leg_id) references vs.leg (operator_id, id),
  foreign key (operator_id, requested_by) references vs.staff_user (operator_id, id)
);
create unique index checkin_pack_scheduled_idx on vs.checkin_pack_send (leg_id) where trigger = 'scheduled';
create index checkin_pack_pending_idx on vs.checkin_pack_send (operator_id) where status = 'pending';
create trigger checkin_pack_send_touch before update on vs.checkin_pack_send
  for each row execute function vs.touch_updated_at();
alter table vs.checkin_pack_send enable row level security;
create policy tenant_isolation on vs.checkin_pack_send for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.checkin_pack_send from vs_backoffice, vs_api, vs_worker;

-- ---------------------------------------------------------------------------
-- The new documents, all per departure.
-- ---------------------------------------------------------------------------
alter table vs.document drop constraint document_kind_check;
alter table vs.document add constraint document_kind_check check (kind in (
  'voucher', 'itinerary', 'payment_schedule', 'cancellation_terms',
  'manifest', 'rooming_list', 'vacancy_sheet', 'outage_pack',
  'embarkation_sheet', 'checkin_file', 'registration_cards'));
