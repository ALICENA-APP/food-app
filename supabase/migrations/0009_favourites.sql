-- Favourites: a person's saved dishes and favourite sellers. Private to them.
create table food.favourites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  product_id uuid references food.products (id) on delete cascade,
  shop_id uuid references food.shops (id) on delete cascade,
  created_at timestamptz not null default now(),
  check ((product_id is null) <> (shop_id is null)),
  unique nulls not distinct (user_id, product_id, shop_id)
);
create index on food.favourites (user_id, created_at desc);
alter table food.favourites enable row level security;
grant select, delete on food.favourites to authenticated;
grant insert (product_id, shop_id) on food.favourites to authenticated;
create policy "favourites: own" on food.favourites
  for select to authenticated using (user_id = auth.uid());
create policy "favourites: add own" on food.favourites
  for insert to authenticated with check (user_id = auth.uid());
create policy "favourites: remove own" on food.favourites
  for delete to authenticated using (user_id = auth.uid());
