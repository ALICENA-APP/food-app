-- Homemade Food App: foundation only (blueprint section 12, build step 1, part 1).
-- Lives in its own `food` schema inside an existing Supabase project.
-- Run once in Supabase > SQL Editor. The rest of the tables come in later
-- migrations, following the Technical V1 Blueprint.

create schema if not exists food;

grant usage on schema food to anon, authenticated, service_role;
alter default privileges in schema food grant all on tables to service_role;
alter default privileges in schema food grant all on sequences to service_role;

-- Admins: granted by SQL or another admin, never self-service.
create table food.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table food.app_admins enable row level security;
grant all on food.app_admins to service_role;

-- Admin check used inside policies: active admin row AND an MFA session.
create function food.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.app_admins a
    where a.user_id = auth.uid() and a.revoked_at is null
  ) and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;
grant execute on function food.is_admin() to anon, authenticated;

-- Profiles: one per signed-in person, created automatically at sign-up.
create table food.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  phone text,
  marketing_consent boolean not null default false,
  marketing_consent_at timestamptz,
  created_at timestamptz not null default now()
);
alter table food.profiles enable row level security;
grant all on food.profiles to service_role;
grant select, update (display_name, phone, marketing_consent, marketing_consent_at)
  on food.profiles to authenticated;
create policy "own profile: read" on food.profiles
  for select to authenticated using (id = auth.uid() or food.is_admin());
create policy "own profile: update" on food.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create function food.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into food.profiles (id) values (new.id) on conflict do nothing;
  return new;
end $$;
create trigger food_on_auth_user_created
  after insert on auth.users
  for each row execute function food.handle_new_user();

-- Audit log: insert-only. Nobody can edit or delete rows; admins can read.
create table food.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role text not null,
  action text not null,
  target_table text,
  target_id text,
  reason text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
alter table food.audit_log enable row level security;
revoke all on food.audit_log from anon, authenticated, service_role;
grant select, insert on food.audit_log to service_role;
grant select on food.audit_log to authenticated;
create policy "admins read audit" on food.audit_log
  for select to authenticated using (food.is_admin());

-- The 14 UK allergens (reference data, public).
create table food.allergens (
  code text primary key,
  name text not null
);
alter table food.allergens enable row level security;
grant select on food.allergens to anon, authenticated;
grant all on food.allergens to service_role;
create policy "allergens are public" on food.allergens for select using (true);
insert into food.allergens (code, name) values
  ('celery', 'Celery'),
  ('cereals_gluten', 'Cereals containing gluten'),
  ('crustaceans', 'Crustaceans'),
  ('eggs', 'Eggs'),
  ('fish', 'Fish'),
  ('lupin', 'Lupin'),
  ('milk', 'Milk'),
  ('molluscs', 'Molluscs'),
  ('mustard', 'Mustard'),
  ('tree_nuts', 'Tree nuts'),
  ('peanuts', 'Peanuts'),
  ('sesame', 'Sesame'),
  ('soya', 'Soya'),
  ('sulphites', 'Sulphur dioxide and sulphites');
