-- Sellers, shops and catalogue (blueprint sections 2, 3, 4, 7 and 8).
-- Orders, payments and reviews come in a later migration.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type food.seller_status as enum (
  'draft', 'submitted', 'in_review', 'approved', 'rejected',
  'reverification_required', 'suspended', 'removed'
);
create type food.verification_kind as enum (
  'food_registration', 'hygiene_rating', 'allergen_declaration', 'insurance'
);
create type food.verification_status as enum ('pending', 'accepted', 'rejected', 'expired');
create type food.shop_status as enum ('draft', 'live', 'paused', 'suspended');
create type food.selling_mode as enum ('available_now', 'scheduled', 'made_to_order');
create type food.product_status as enum ('draft', 'published', 'archived');
create type food.allergen_presence as enum ('contains', 'may_contain', 'not_present');
create type food.availability_kind as enum ('weekly', 'date_window');

create function food.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Sellers
-- ---------------------------------------------------------------------------
create table food.seller_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique default auth.uid() references auth.users (id) on delete restrict,
  status food.seller_status not null default 'draft',
  legal_name text check (char_length(legal_name) <= 200),
  trading_name text check (char_length(trading_name) <= 200),
  business_type text check (business_type in ('sole_trader', 'limited_company', 'partnership', 'other')),
  stripe_account_id text unique,
  charges_enabled boolean not null default false,
  payouts_enabled boolean not null default false,
  terms_version text,
  terms_accepted_at timestamptz,
  submitted_at timestamptz,
  approved_by uuid references auth.users (id),
  approved_at timestamptz,
  status_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger seller_accounts_touch before update on food.seller_accounts
  for each row execute function food.touch_updated_at();

create table food.seller_verifications (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references food.seller_accounts (id) on delete cascade,
  kind food.verification_kind not null,
  status food.verification_status not null default 'pending',
  authority text check (char_length(authority) <= 200),     -- e.g. the council
  reference text check (char_length(reference) <= 100),     -- registration number
  registered_on date,
  fhrs_id text check (char_length(fhrs_id) <= 20),          -- FSA ratings id
  rating smallint check (rating between 0 and 5),
  rating_date date,
  document_path text,                                       -- in the seller-documents bucket
  notes text check (char_length(notes) <= 2000),
  expires_at date,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on food.seller_verifications (seller_account_id);

-- ---------------------------------------------------------------------------
-- Shops
-- ---------------------------------------------------------------------------
create table food.shops (
  id uuid primary key default gen_random_uuid(),
  seller_account_id uuid not null references food.seller_accounts (id) on delete restrict,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name text not null check (char_length(name) between 2 and 80),
  story text check (char_length(story) <= 2000),
  logo_path text,
  cover_path text,
  cuisines text[] not null default '{}',
  area_label text check (char_length(area_label) <= 60),     -- e.g. 'Bow, E3'. Never an address.
  status food.shop_status not null default 'draft',
  accepting_orders boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on food.shops (seller_account_id);
create trigger shops_touch before update on food.shops
  for each row execute function food.touch_updated_at();

-- Private shop details: only the owner and admins can read these.
create table food.shop_private (
  shop_id uuid primary key references food.shops (id) on delete cascade,
  address_line1 text check (char_length(address_line1) <= 200),
  address_line2 text check (char_length(address_line2) <= 200),
  city text check (char_length(city) <= 100),
  postcode text check (char_length(postcode) <= 10),
  collection_instructions text check (char_length(collection_instructions) <= 500),
  contact_phone text check (char_length(contact_phone) <= 30)
);

create table food.shop_settings (
  shop_id uuid primary key references food.shops (id) on delete cascade,
  offers_collection boolean not null default true,
  offers_delivery boolean not null default false,
  min_order_pence integer not null default 0 check (min_order_pence between 0 and 100000),
  default_lead_minutes integer not null default 60 check (default_lead_minutes between 0 and 43200),
  acceptance_window_minutes integer not null default 720 check (acceptance_window_minutes between 15 and 2880)
);

create table food.shop_hours (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),  -- 0 = Monday
  opens time not null,
  closes time not null,
  check (closes > opens)
);
create index on food.shop_hours (shop_id);

create table food.shop_closures (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  closed_on date not null,
  reason text check (char_length(reason) <= 200),
  unique (shop_id, closed_on)
);

create table food.shop_delivery_zones (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  name text not null check (char_length(name) <= 60),
  postcode_districts text[] not null check (cardinality(postcode_districts) between 1 and 50),
  fee_pence integer not null default 0 check (fee_pence between 0 and 10000),
  min_order_pence integer not null default 0 check (min_order_pence between 0 and 100000)
);
create index on food.shop_delivery_zones (shop_id);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
create table food.categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  sort smallint not null default 0
);
insert into food.categories (slug, name, sort) values
  ('cakes-bakes', 'Cakes and bakes', 1),
  ('desserts', 'Desserts', 2),
  ('meals', 'Meals', 3),
  ('sides-snacks', 'Sides and snacks', 4),
  ('breakfast', 'Breakfast', 5),
  ('drinks', 'Drinks', 6),
  ('preserves-sauces', 'Preserves and sauces', 7),
  ('meal-prep', 'Meal prep', 8);

create table food.products (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete restrict,
  name text not null check (char_length(name) between 2 and 100),
  description text check (char_length(description) <= 2000),
  category_id uuid references food.categories (id),
  selling_mode food.selling_mode not null default 'available_now',
  price_pence integer not null check (price_pence between 50 and 100000),
  serves smallint check (serves between 1 and 100),
  portion text check (char_length(portion) <= 60),
  stock_qty integer check (stock_qty >= 0),                  -- null = unlimited
  prep_minutes integer check (prep_minutes between 0 and 10080),
  min_lead_hours integer check (min_lead_hours between 0 and 720),
  collection_ok boolean not null default true,
  delivery_ok boolean not null default true,
  ingredients text check (char_length(ingredients) <= 2000),
  dietary text[] not null default '{}',                      -- e.g. vegan, halal
  may_contain_notes text check (char_length(may_contain_notes) <= 500),
  status food.product_status not null default 'draft',
  allergens_confirmed_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (collection_ok or delivery_ok)
);
create index on food.products (shop_id, status);

create table food.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references food.products (id) on delete cascade,
  path text not null,                                        -- in the product-images bucket
  sort smallint not null default 0
);
create index on food.product_images (product_id);

create table food.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references food.products (id) on delete cascade,
  group_name text not null check (char_length(group_name) <= 40),   -- e.g. Size
  name text not null check (char_length(name) <= 60),               -- e.g. 8 inch
  price_delta_pence integer not null default 0 check (price_delta_pence between -100000 and 100000),
  stock_qty integer check (stock_qty >= 0),
  sort smallint not null default 0
);
create index on food.product_variants (product_id);

create table food.product_addons (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references food.products (id) on delete cascade,
  name text not null check (char_length(name) <= 60),
  price_pence integer not null default 0 check (price_pence between 0 and 100000),
  sort smallint not null default 0
);
create index on food.product_addons (product_id);

-- One row per allergen per product (variant_id and addon_id null), plus extra
-- rows for a variant or add-on that brings its own allergen.
create table food.product_allergens (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references food.products (id) on delete cascade,
  variant_id uuid references food.product_variants (id) on delete cascade,
  addon_id uuid references food.product_addons (id) on delete cascade,
  allergen_code text not null references food.allergens (code),
  presence food.allergen_presence not null,
  unique nulls not distinct (product_id, variant_id, addon_id, allergen_code),
  check (variant_id is null or addon_id is null)
);

create table food.product_availability (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references food.products (id) on delete cascade,
  kind food.availability_kind not null,
  weekday smallint check (weekday between 0 and 6),
  available_on date,
  window_start time not null,
  window_end time not null,
  order_cutoff_hours integer not null default 0 check (order_cutoff_hours between 0 and 336),
  qty_cap integer check (qty_cap > 0),
  check (window_end > window_start),
  check ((kind = 'weekly' and weekday is not null and available_on is null)
      or (kind = 'date_window' and available_on is not null and weekday is null))
);
create index on food.product_availability (product_id);

-- ---------------------------------------------------------------------------
-- Helper functions used by policies (security definer avoids RLS recursion)
-- ---------------------------------------------------------------------------
create function food.my_seller_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from food.seller_accounts where user_id = auth.uid()
$$;

create function food.owns_shop(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.shops s
    join food.seller_accounts a on a.id = s.seller_account_id
    where s.id = p_shop and a.user_id = auth.uid()
  )
$$;

create function food.owns_product(p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.products p
    join food.shops s on s.id = p.shop_id
    join food.seller_accounts a on a.id = s.seller_account_id
    where p.id = p_product and a.user_id = auth.uid()
  )
$$;

-- A shop is public only when it is live and its seller is approved and able
-- to take payments.
create function food.shop_is_public(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.shops s
    join food.seller_accounts a on a.id = s.seller_account_id
    where s.id = p_shop and s.status = 'live'
      and a.status = 'approved' and a.charges_enabled
  )
$$;

create function food.product_is_public(p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.products p
    where p.id = p_product and p.status = 'published' and food.shop_is_public(p.shop_id)
  )
$$;

create function food.product_allergens_complete(p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (
    select count(distinct pa.allergen_code) from food.product_allergens pa
    where pa.product_id = p_product and pa.variant_id is null and pa.addon_id is null
  ) = (select count(*) from food.allergens)
$$;

grant execute on function
  food.my_seller_account_id(), food.owns_shop(uuid), food.owns_product(uuid),
  food.shop_is_public(uuid), food.product_is_public(uuid), food.product_allergens_complete(uuid)
to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Rules enforced in the database
-- ---------------------------------------------------------------------------

-- Publishing needs all 14 allergens answered and confirmed. Editing the
-- ingredients of a published product sends it back to draft for re-confirming.
create function food.products_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
    if old.status = 'published'
       and new.ingredients is distinct from old.ingredients then
      new.status := 'draft';
      new.allergens_confirmed_at := null;
    end if;
  end if;
  if new.status = 'published' then
    if new.allergens_confirmed_at is null then
      raise exception 'Confirm the allergen information before publishing';
    end if;
    if not food.product_allergens_complete(new.id) then
      raise exception 'Answer all 14 allergens before publishing';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger products_guard before insert or update on food.products
  for each row execute function food.products_guard();

create function food.allergens_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_product uuid := coalesce(new.product_id, old.product_id);
begin
  update food.products
     set status = 'draft', allergens_confirmed_at = null
   where id = v_product and status = 'published';
  return null;
end $$;
create trigger product_allergens_changed after insert or update or delete on food.product_allergens
  for each row execute function food.allergens_changed();

-- A shop can only go live when its seller is approved and Stripe-enabled.
create function food.shops_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'live' and (tg_op = 'INSERT' or old.status is distinct from 'live') then
    if not exists (
      select 1 from food.seller_accounts a
      where a.id = new.seller_account_id and a.status = 'approved' and a.charges_enabled
    ) then
      raise exception 'Shop can go live only after seller approval and Stripe setup';
    end if;
  end if;
  return new;
end $$;
create trigger shops_guard before insert or update on food.shops
  for each row execute function food.shops_guard();

-- Seller status changes are always audited.
create function food.audit_seller_status() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, before, after)
    values (auth.uid(), coalesce(auth.role(), 'system'), 'seller_status_change', 'seller_accounts',
            new.id::text, new.status_note,
            jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  end if;
  return new;
end $$;
create trigger seller_accounts_audit after update on food.seller_accounts
  for each row execute function food.audit_seller_status();

-- Sellers submit their application through this function, which checks it is
-- complete. Approval happens only through admin functions.
create function food.submit_seller_application() returns food.seller_status
language plpgsql security definer set search_path = '' as $$
declare
  v_account food.seller_accounts;
begin
  select * into v_account from food.seller_accounts where user_id = auth.uid();
  if v_account.id is null then
    raise exception 'No seller account';
  end if;
  if v_account.status not in ('draft', 'reverification_required') then
    raise exception 'Application already submitted';
  end if;
  if v_account.legal_name is null or v_account.business_type is null then
    raise exception 'Add your business details first';
  end if;
  if v_account.terms_accepted_at is null then
    raise exception 'Accept the seller terms first';
  end if;
  if not exists (select 1 from food.seller_verifications
                 where seller_account_id = v_account.id and kind = 'food_registration'
                   and status <> 'rejected') then
    raise exception 'Add your food business registration first';
  end if;
  if not exists (select 1 from food.seller_verifications
                 where seller_account_id = v_account.id and kind = 'allergen_declaration'
                   and status <> 'rejected') then
    raise exception 'Complete the allergen declaration first';
  end if;
  update food.seller_accounts
     set status = 'submitted', submitted_at = now()
   where id = v_account.id;
  return 'submitted';
end $$;
revoke execute on function food.submit_seller_application() from public, anon;
grant execute on function food.submit_seller_application() to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------
alter table food.seller_accounts enable row level security;
alter table food.seller_verifications enable row level security;
alter table food.shops enable row level security;
alter table food.shop_private enable row level security;
alter table food.shop_settings enable row level security;
alter table food.shop_hours enable row level security;
alter table food.shop_closures enable row level security;
alter table food.shop_delivery_zones enable row level security;
alter table food.categories enable row level security;
alter table food.products enable row level security;
alter table food.product_images enable row level security;
alter table food.product_variants enable row level security;
alter table food.product_addons enable row level security;
alter table food.product_allergens enable row level security;
alter table food.product_availability enable row level security;

-- Seller accounts: owner reads and edits business details while in draft.
grant select on food.seller_accounts to authenticated;
grant insert (legal_name, trading_name, business_type) on food.seller_accounts to authenticated;
grant update (legal_name, trading_name, business_type, terms_version, terms_accepted_at)
  on food.seller_accounts to authenticated;
create policy "seller account: owner or admin reads" on food.seller_accounts
  for select to authenticated using (user_id = auth.uid() or food.is_admin());
create policy "seller account: owner creates" on food.seller_accounts
  for insert to authenticated with check (user_id = auth.uid());
create policy "seller account: owner edits draft" on food.seller_accounts
  for update to authenticated
  using (user_id = auth.uid() and status in ('draft', 'reverification_required'))
  with check (user_id = auth.uid());

-- Verifications: owner adds and edits pending ones; decisions are admin-only.
grant select on food.seller_verifications to authenticated;
grant insert (seller_account_id, kind, authority, reference, registered_on, fhrs_id,
              rating, rating_date, document_path, notes, expires_at)
  on food.seller_verifications to authenticated;
grant update (authority, reference, registered_on, fhrs_id, rating, rating_date,
              document_path, notes, expires_at)
  on food.seller_verifications to authenticated;
grant delete on food.seller_verifications to authenticated;
create policy "verification: owner or admin reads" on food.seller_verifications
  for select to authenticated
  using (seller_account_id = food.my_seller_account_id() or food.is_admin());
create policy "verification: owner adds" on food.seller_verifications
  for insert to authenticated with check (seller_account_id = food.my_seller_account_id());
create policy "verification: owner edits pending" on food.seller_verifications
  for update to authenticated
  using (seller_account_id = food.my_seller_account_id() and status = 'pending')
  with check (seller_account_id = food.my_seller_account_id());
create policy "verification: owner removes pending" on food.seller_verifications
  for delete to authenticated
  using (seller_account_id = food.my_seller_account_id() and status = 'pending');

-- Shops: public reads live shops; owner manages everything but the status.
grant select on food.shops to anon, authenticated;
grant insert (seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label)
  on food.shops to authenticated;
grant update (slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders)
  on food.shops to authenticated;
create policy "shop: public reads live" on food.shops
  for select using (food.shop_is_public(id));
create policy "shop: owner or admin reads" on food.shops
  for select to authenticated using (food.owns_shop(id) or food.is_admin());
create policy "shop: owner creates" on food.shops
  for insert to authenticated with check (seller_account_id = food.my_seller_account_id());
create policy "shop: owner edits" on food.shops
  for update to authenticated
  using (food.owns_shop(id) and status <> 'suspended')
  with check (food.owns_shop(id) and status in ('draft', 'live', 'paused'));

-- Private shop details: owner and admin only.
grant select, insert, update on food.shop_private to authenticated;
create policy "shop private: owner or admin reads" on food.shop_private
  for select to authenticated using (food.owns_shop(shop_id) or food.is_admin());
create policy "shop private: owner writes" on food.shop_private
  for insert to authenticated with check (food.owns_shop(shop_id));
create policy "shop private: owner updates" on food.shop_private
  for update to authenticated using (food.owns_shop(shop_id)) with check (food.owns_shop(shop_id));

-- Shop settings, hours, closures, delivery zones: public reads for live
-- shops, owner manages.
do $$
declare
  t text;
begin
  foreach t in array array['shop_settings', 'shop_hours', 'shop_closures', 'shop_delivery_zones'] loop
    execute format('grant select on food.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on food.%I to authenticated', t);
    execute format('create policy "%s: public reads live" on food.%I for select using (food.shop_is_public(shop_id))', t, t);
    execute format('create policy "%s: owner or admin reads" on food.%I for select to authenticated using (food.owns_shop(shop_id) or food.is_admin())', t, t);
    execute format('create policy "%s: owner adds" on food.%I for insert to authenticated with check (food.owns_shop(shop_id))', t, t);
    execute format('create policy "%s: owner edits" on food.%I for update to authenticated using (food.owns_shop(shop_id)) with check (food.owns_shop(shop_id))', t, t);
    execute format('create policy "%s: owner removes" on food.%I for delete to authenticated using (food.owns_shop(shop_id))', t, t);
  end loop;
end $$;

-- Categories: public list, admin-managed.
grant select on food.categories to anon, authenticated;
create policy "categories are public" on food.categories for select using (true);

-- Products: public reads published products of live shops; owner manages.
grant select on food.products to anon, authenticated;
grant insert (shop_id, name, description, category_id, selling_mode, price_pence, serves, portion,
              stock_qty, prep_minutes, min_lead_hours, collection_ok, delivery_ok, ingredients,
              dietary, may_contain_notes, status, allergens_confirmed_at)
  on food.products to authenticated;
grant update (name, description, category_id, selling_mode, price_pence, serves, portion,
              stock_qty, prep_minutes, min_lead_hours, collection_ok, delivery_ok, ingredients,
              dietary, may_contain_notes, status, allergens_confirmed_at)
  on food.products to authenticated;
create policy "product: public reads published" on food.products
  for select using (food.product_is_public(id));
create policy "product: owner or admin reads" on food.products
  for select to authenticated using (food.owns_shop(shop_id) or food.is_admin());
create policy "product: owner adds" on food.products
  for insert to authenticated with check (food.owns_shop(shop_id));
create policy "product: owner edits" on food.products
  for update to authenticated using (food.owns_shop(shop_id)) with check (food.owns_shop(shop_id));

-- Product details: same pattern, through the product.
do $$
declare
  t text;
begin
  foreach t in array array['product_images', 'product_variants', 'product_addons',
                           'product_allergens', 'product_availability'] loop
    execute format('grant select on food.%I to anon, authenticated', t);
    execute format('grant insert, update, delete on food.%I to authenticated', t);
    execute format('create policy "%s: public reads published" on food.%I for select using (food.product_is_public(product_id))', t, t);
    execute format('create policy "%s: owner or admin reads" on food.%I for select to authenticated using (food.owns_product(product_id) or food.is_admin())', t, t);
    execute format('create policy "%s: owner adds" on food.%I for insert to authenticated with check (food.owns_product(product_id))', t, t);
    execute format('create policy "%s: owner edits" on food.%I for update to authenticated using (food.owns_product(product_id)) with check (food.owns_product(product_id))', t, t);
    execute format('create policy "%s: owner removes" on food.%I for delete to authenticated using (food.owns_product(product_id))', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Storage buckets
-- ---------------------------------------------------------------------------
-- Product and shop photos: public to view, 300 KB cap each to protect the
-- free 1 GB of storage. Files live under <shop id>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 307200, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do nothing;

-- Compliance documents: private, 5 MB cap. Files live under <seller account id>/...
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('seller-documents', 'seller-documents', false, 5242880,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "product images: shop owner uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images'
              and food.owns_shop(((storage.foldername(name))[1])::uuid));
create policy "product images: shop owner replaces" on storage.objects
  for update to authenticated
  using (bucket_id = 'product-images'
         and food.owns_shop(((storage.foldername(name))[1])::uuid));
create policy "product images: shop owner deletes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images'
         and food.owns_shop(((storage.foldername(name))[1])::uuid));

create policy "seller documents: owner uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'seller-documents'
              and (storage.foldername(name))[1] = food.my_seller_account_id()::text);
create policy "seller documents: owner or admin reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'seller-documents'
         and ((storage.foldername(name))[1] = food.my_seller_account_id()::text or food.is_admin()));
