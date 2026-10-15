-- Food App: its own schema inside an existing Supabase project.
-- Run this once in Supabase > SQL Editor.

create schema if not exists food;

grant usage on schema food to anon, authenticated, service_role;
alter default privileges in schema food
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema food
  grant all on sequences to anon, authenticated, service_role;

-- Starter table: foods each signed-in user has saved.
create table if not exists food.items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  notes text,
  created_at timestamptz not null default now()
);

grant all on food.items to anon, authenticated, service_role;

-- Row-level security: people only ever see and change their own rows.
alter table food.items enable row level security;

create policy "read own items" on food.items
  for select to authenticated using (user_id = auth.uid());
create policy "add own items" on food.items
  for insert to authenticated with check (user_id = auth.uid());
create policy "edit own items" on food.items
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own items" on food.items
  for delete to authenticated using (user_id = auth.uid());
