-- Platform admin area (agreed 2026-10-24): the platform owner (Riverdesk, not a cruise company)
-- adds companies from the back office and sees a list of them with counts only, never their
-- bookings or guests. Platform data lives in schema `platform`, owned by vs_owner and not
-- granted to any runtime role; the back office reaches it only through three allow-listed
-- SECURITY DEFINER functions, each of which first checks that the caller is a platform admin.

create schema platform;
revoke all on schema platform from public;

-- Who may use the platform area: a verified Supabase Auth email (added with
-- `pnpm platform:add-admin`). Signing in still needs a password and the two-step code.
create table platform.admin (
  email text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'),
  added_at timestamptz not null default now(),
  added_by text not null
);

-- Every platform action, kept apart from the companies' own audit logs.
create table platform.action_log (
  id uuid primary key default vs.uuid_v7(),
  admin_email text not null,
  action text not null check (action ~ '^[a-z][a-z0-9_.]*$'),
  operator_id uuid references vs.operator (id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Creates a company with its settings, its back-office channel and an invitation for its
-- first owner, in one go. Shared by the CLI (as vs_owner) and the platform area (through
-- vs.platform_create_company). Not executable by any runtime role.
create function platform.create_company(
  p_name text, p_slug text, p_prefix text, p_owner_email text, p_owner_name text,
  p_locale text, p_actor_label text
)
returns table (operator_id uuid, back_office_channel_id uuid, invitation_id uuid)
language plpgsql volatile
set search_path = ''
as $$
declare
  v_operator uuid;
  v_channel uuid;
  v_invitation uuid;
begin
  insert into vs.operator (name, slug, default_locale)
  values (p_name, p_slug, coalesce(p_locale, 'ar')) returning id into v_operator;
  insert into vs.operator_setting (operator_id, booking_ref_prefix) values (v_operator, p_prefix);
  insert into vs.channel (operator_id, code, name, type)
  values (v_operator, 'back-office', 'Back office (phone, WhatsApp, walk-in)', 'back_office')
  returning id into v_channel;
  insert into vs.staff_invitation (operator_id, email, display_name, role)
  values (v_operator, lower(p_owner_email), p_owner_name, 'owner') returning id into v_invitation;
  insert into vs.audit_log (operator_id, actor_type, actor_label, action, entity, entity_id, diff)
  values (v_operator, 'system', p_actor_label, 'operator.created', 'operator', v_operator,
          jsonb_build_object('name', jsonb_build_object('from', null, 'to', p_name),
                             'slug', jsonb_build_object('from', null, 'to', p_slug),
                             'owner_invited', jsonb_build_object('from', null, 'to', true)));
  return query select v_operator, v_channel, v_invitation;
end
$$;

-- Back office: is this verified email a platform admin?
create function vs.platform_is_admin(p_email text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select from platform.admin a where a.email = lower(p_email))
$$;
revoke execute on function vs.platform_is_admin(text) from public, vs_api, vs_worker;

-- Back office: every company with counts only. Raises for anyone who is not a platform admin.
create function vs.platform_companies(p_admin_email text)
returns table (
  id uuid, name text, slug text, booking_ref_prefix text, created_at timestamptz,
  owner_active boolean, open_invitations int, staff int, vessels int, bookings int
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not exists (select from platform.admin a where a.email = lower(p_admin_email)) then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  return query
  select o.id, o.name, o.slug, s.booking_ref_prefix, o.created_at,
         exists (select from vs.staff_user u where u.operator_id = o.id and u.role = 'owner' and u.active),
         (select count(*)::int from vs.staff_invitation i
           where i.operator_id = o.id and i.accepted_at is null and i.expires_at > now()),
         (select count(*)::int from vs.staff_user u where u.operator_id = o.id and u.active),
         (select count(*)::int from vs.vessel v where v.operator_id = o.id),
         (select count(*)::int from vs.booking b where b.operator_id = o.id)
  from vs.operator o
  left join vs.operator_setting s on s.operator_id = o.id
  order by o.created_at desc;
end
$$;
revoke execute on function vs.platform_companies(text) from public, vs_api, vs_worker;

-- Back office: add a company and invite its first owner. Raises for a non-admin.
create function vs.platform_create_company(
  p_admin_email text, p_name text, p_slug text, p_prefix text, p_owner_email text,
  p_owner_name text, p_locale text
)
returns table (operator_id uuid, invitation_id uuid)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_created record;
begin
  if not exists (select from platform.admin a where a.email = lower(p_admin_email)) then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  select * into v_created from platform.create_company(
    p_name, p_slug, p_prefix, p_owner_email, p_owner_name, p_locale, 'platform admin');
  insert into platform.action_log (admin_email, action, operator_id, detail)
  values (lower(p_admin_email), 'company.created', v_created.operator_id,
          jsonb_build_object('name', p_name, 'slug', p_slug, 'owner_email', lower(p_owner_email)));
  return query select v_created.operator_id, v_created.invitation_id;
end
$$;
revoke execute on function vs.platform_create_company(text, text, text, text, text, text, text)
  from public, vs_api, vs_worker;

-- Back office: a new owner invitation for a company with no active owner (the first one
-- expired, or was sent to the wrong address). Replaces any open owner invitation.
create function vs.platform_reinvite_owner(
  p_admin_email text, p_operator_id uuid, p_owner_email text, p_owner_name text
)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_invitation uuid;
begin
  if not exists (select from platform.admin a where a.email = lower(p_admin_email)) then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;
  if exists (select from vs.staff_user u
             where u.operator_id = p_operator_id and u.role = 'owner' and u.active) then
    raise exception 'company already has an owner' using errcode = '23514';
  end if;
  delete from vs.staff_invitation
  where operator_id = p_operator_id and role = 'owner' and accepted_at is null;
  -- The open-email index ignores expiry, so an expired open invitation for this email goes too.
  delete from vs.staff_invitation
  where lower(email) = lower(p_owner_email) and accepted_at is null and expires_at <= now();
  insert into vs.staff_invitation (operator_id, email, display_name, role)
  values (p_operator_id, lower(p_owner_email), p_owner_name, 'owner') returning id into v_invitation;
  insert into vs.audit_log (operator_id, actor_type, actor_label, action, entity, entity_id, diff)
  values (p_operator_id, 'system', 'platform admin', 'staff_invitation.created', 'staff_invitation',
          v_invitation, jsonb_build_object('role', jsonb_build_object('from', null, 'to', 'owner')));
  insert into platform.action_log (admin_email, action, operator_id, detail)
  values (lower(p_admin_email), 'owner.reinvited', p_operator_id,
          jsonb_build_object('owner_email', lower(p_owner_email)));
  return v_invitation;
end
$$;
revoke execute on function vs.platform_reinvite_owner(text, uuid, text, text)
  from public, vs_api, vs_worker;
