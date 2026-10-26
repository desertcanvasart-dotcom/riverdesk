-- Branding (Batch D1, agreed 2026-10-26): each company's logo, two colours and the contact block
-- printed on every document. Kept apart from operator_setting, which is read on every request,
-- so the logo bytes are only loaded when a document or the Branding screen needs them. A company
-- without a row uses the Riverdesk defaults.

create table vs.operator_branding (
  operator_id uuid primary key references vs.operator (id),
  primary_color text not null default '#165a5c' check (primary_color ~ '^#[0-9a-f]{6}$'),
  secondary_color text not null default '#c58b3c' check (secondary_color ~ '^#[0-9a-f]{6}$'),
  -- PNG or JPEG, embedded in documents as a data: URL (the renderer fetches nothing).
  logo bytea check (octet_length(logo) <= 204800),
  logo_type text check (logo_type in ('image/png', 'image/jpeg')),
  phone text check (length(phone) <= 50),
  whatsapp text check (length(whatsapp) <= 50),
  email text check (length(email) <= 254),
  website text check (length(website) <= 200),
  address_ar text check (length(address_ar) <= 300),
  address_en text check (length(address_en) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((logo is null) = (logo_type is null))
);
create trigger operator_branding_touch before update on vs.operator_branding
  for each row execute function vs.touch_updated_at();
alter table vs.operator_branding enable row level security;
create policy tenant_isolation on vs.operator_branding for all to vs_backoffice, vs_api, vs_worker
  using (operator_id = vs.current_operator_id())
  with check (operator_id = vs.current_operator_id());
revoke delete on vs.operator_branding from vs_backoffice, vs_api, vs_worker;

-- Documents in both languages at once: Arabic first, English beneath each label.
alter table vs.document drop constraint document_locale_check;
alter table vs.document add constraint document_locale_check
  check (locale in ('ar', 'en', 'both'));
