-- Company onboarding (agreed 2026-10-24): the platform owner creates a company and invites its
-- first owner by email. The invitation is claimed when that person signs in with the same,
-- verified email (Supabase Auth); no service_role key is needed anywhere.

create table vs.staff_invitation (
  id uuid primary key default vs.uuid_v7(),
  operator_id uuid not null references vs.operator (id),
  email text not null check (email ~ '^[^@\s]+@[^@\s]+$'),
  display_name text not null check (length(display_name) between 1 and 200),
  role text not null check (role in ('owner', 'reservations', 'finance', 'read_only')),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  staff_user_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, id),
  check ((accepted_at is null) = (staff_user_id is null)),
  foreign key (operator_id, staff_user_id) references vs.staff_user (operator_id, id)
);
-- One open invitation per email across the platform: a login belongs to one company.
create unique index staff_invitation_open_email_idx on vs.staff_invitation (lower(email)) where accepted_at is null;
create trigger staff_invitation_touch before update on vs.staff_invitation
  for each row execute function vs.touch_updated_at();
alter table vs.staff_invitation enable row level security;
create policy tenant_isolation on vs.staff_invitation for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.staff_invitation from vs_backoffice, vs_api, vs_worker;

-- Runs before the tenant is known (first sign-in): links a verified email to its open
-- invitation, creating the staff_user. Returns the same shape as resolve_staff. Back office only.
create function vs.claim_staff_invitation(p_auth_user_id uuid, p_email text)
returns table (staff_user_id uuid, operator_id uuid, role text)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_invitation vs.staff_invitation;
  v_staff_id uuid;
begin
  if exists (select from vs.staff_user s where s.auth_user_id = p_auth_user_id) then
    return query select s.id, s.operator_id, s.role from vs.staff_user s
      where s.auth_user_id = p_auth_user_id and s.active;
    return;
  end if;
  select * into v_invitation from vs.staff_invitation i
  where lower(i.email) = lower(p_email) and i.accepted_at is null and i.expires_at > now()
  for update;
  if not found then
    return;
  end if;
  insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role)
  values (v_invitation.operator_id, p_auth_user_id, lower(p_email), v_invitation.display_name, v_invitation.role)
  returning id into v_staff_id;
  update vs.staff_invitation set accepted_at = now(), staff_user_id = v_staff_id where id = v_invitation.id;
  insert into vs.audit_log (operator_id, actor_type, actor_id, actor_label, action, entity, entity_id, diff)
  values (v_invitation.operator_id, 'staff', v_staff_id, 'first sign-in', 'staff_invitation.accepted',
          'staff_user', v_staff_id, jsonb_build_object('role', jsonb_build_object('from', null, 'to', v_invitation.role)));
  return query select v_staff_id, v_invitation.operator_id, v_invitation.role;
end
$$;
revoke execute on function vs.claim_staff_invitation(uuid, text) from public, vs_api, vs_worker;
