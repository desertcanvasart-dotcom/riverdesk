-- Founding Operator Program: pilot requests sent from the public website's /pilot form.
-- They are platform data, not a company's, so they live in schema `platform`, granted to no
-- runtime role. The website logs in as vs_website, which has no table rights at all and can
-- only call vs.submit_pilot_request. That function also limits how often one client (a keyed
-- hash of its IP address, never the address itself) may submit.

create table platform.pilot_request (
  id uuid primary key default vs.uuid_v7(),
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  company_name text not null check (char_length(btrim(company_name)) between 1 and 160),
  vessel_names text not null check (char_length(btrim(vessel_names)) between 1 and 300),
  vessel_count text check (vessel_count in ('1', '2-4', '5+')),
  vessel_type text check (vessel_type in ('cruise', 'dahabiya', 'both')),
  -- E.164, normalised by the website: +201001234567.
  whatsapp text not null check (whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  email text check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  home_port text check (home_port in ('luxor', 'aswan', 'cairo', 'other')),
  current_tool text check (current_tool in ('excel', 'whatsapp', 'paper', 'other_system', 'other')),
  message text check (char_length(message) <= 2000),
  locale text not null check (locale in ('ar', 'en')),
  consent_at timestamptz not null,
  client_hash text not null check (client_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
create index pilot_request_client_idx on platform.pilot_request (client_hash, created_at);

-- Website: store one pilot request (the visitor must have ticked the consent box). Raises 'rate_limited' (P0001) after 3 requests from the
-- same client in an hour or 10 in a day. Returns the new request's id.
create function vs.submit_pilot_request(p_request jsonb, p_client_hash text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if (p_request ->> 'consent') is distinct from 'true' then
    raise exception 'consent is required' using errcode = '23514';
  end if;
  if (select count(*) from platform.pilot_request r
      where r.client_hash = p_client_hash and r.created_at > now() - interval '1 hour') >= 3
     or (select count(*) from platform.pilot_request r
      where r.client_hash = p_client_hash and r.created_at > now() - interval '1 day') >= 10
  then
    raise exception 'rate_limited';
  end if;
  insert into platform.pilot_request (
    full_name, company_name, vessel_names, vessel_count, vessel_type, whatsapp, email,
    home_port, current_tool, message, locale, consent_at, client_hash
  ) values (
    btrim(p_request ->> 'full_name'), btrim(p_request ->> 'company_name'),
    btrim(p_request ->> 'vessel_names'), p_request ->> 'vessel_count',
    p_request ->> 'vessel_type', p_request ->> 'whatsapp', lower(p_request ->> 'email'),
    p_request ->> 'home_port', p_request ->> 'current_tool',
    nullif(btrim(p_request ->> 'message'), ''), p_request ->> 'locale', now(), p_client_hash
  ) returning id into v_id;
  return v_id;
end
$$;
revoke execute on function vs.submit_pilot_request(jsonb, text)
  from public, vs_backoffice, vs_api, vs_worker;
grant execute on function vs.submit_pilot_request(jsonb, text) to vs_website;
