-- Dishes made only on some days, copying a dish, a waitlist for areas with
-- no cooks yet, and announcements from the BiteBY team.

-- ---------- Available days (0 = Monday ... 6 = Sunday; empty = every day) ----------
alter table food.products add column available_days smallint[] not null default '{}'
  check (available_days <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[]);
grant insert (available_days), update (available_days) on food.products to authenticated;

create function food.day_name(d int) returns text
language sql immutable set search_path = '' as $$
  select (array['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])[d + 1]
$$;

-- Checked for every dish in an order, against the day the order is for.
create function food.check_available_day() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_days smallint[];
  v_name text;
  v_day int;
begin
  select p.available_days, p.name into v_days, v_name from food.products p where p.id = new.product_id;
  if cardinality(v_days) = 0 then return new; end if;
  select extract(isodow from (coalesce(o.requested_for, now()) at time zone 'Europe/London'))::int - 1 into v_day
    from food.orders o where o.id = new.order_id;
  if not (v_day = any (v_days)) then
    raise exception '% is only made on %. Choose one of those days for your order.', v_name,
      (select string_agg(food.day_name(d), ', ' order by d) from unnest(v_days) d);
  end if;
  return new;
end $$;
create trigger order_items_available_day before insert on food.order_items
  for each row execute function food.check_available_day();

-- ---------- Copy a dish ----------
-- Makes a draft copy with the same details, sizes, extras and allergens.
-- Photos aren't copied, so deleting one dish's photo never affects the other.
create function food.copy_product(p_product uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  p food.products;
  v_new uuid := gen_random_uuid();
  r record;
  v_map jsonb := '{}';
  v_id uuid;
begin
  select * into p from food.products where id = p_product;
  if not found or not food.owns_shop(p.shop_id) then
    raise exception 'Dish not found';
  end if;
  if (select count(*) from food.products where shop_id = p.shop_id and status <> 'archived') >= 200 then
    raise exception 'You have a lot of dishes already. Archive some first.';
  end if;
  insert into food.products (id, shop_id, name, description, category_id, selling_mode, price_pence, serves, portion,
                             stock_qty, prep_minutes, min_lead_hours, collection_ok, delivery_ok, ingredients,
                             dietary, may_contain_notes, status, available_days)
  values (v_new, p.shop_id, left(p.name || ' (copy)', 100), p.description, p.category_id, p.selling_mode, p.price_pence,
          p.serves, p.portion, p.stock_qty, p.prep_minutes, p.min_lead_hours, p.collection_ok, p.delivery_ok,
          p.ingredients, p.dietary, p.may_contain_notes, 'draft', p.available_days);
  for r in select * from food.product_variants where product_id = p.id loop
    v_id := gen_random_uuid();
    insert into food.product_variants (id, product_id, group_name, name, price_delta_pence, stock_qty, sort)
    values (v_id, v_new, r.group_name, r.name, r.price_delta_pence, r.stock_qty, r.sort);
    v_map := v_map || jsonb_build_object(r.id::text, v_id);
  end loop;
  for r in select * from food.product_addons where product_id = p.id loop
    v_id := gen_random_uuid();
    insert into food.product_addons (id, product_id, name, price_pence, sort)
    values (v_id, v_new, r.name, r.price_pence, r.sort);
    v_map := v_map || jsonb_build_object(r.id::text, v_id);
  end loop;
  insert into food.product_allergens (product_id, variant_id, addon_id, allergen_code, presence)
  select v_new, (v_map ->> a.variant_id::text)::uuid, (v_map ->> a.addon_id::text)::uuid, a.allergen_code, a.presence
    from food.product_allergens a where a.product_id = p.id;
  return v_new;
end $$;
revoke execute on function food.copy_product(uuid) from public, anon;
grant execute on function food.copy_product(uuid) to authenticated;

-- ---------- Waitlist for areas with no cooks yet ----------
create table food.area_waitlist (
  user_id uuid not null references auth.users (id) on delete cascade,
  district text not null check (district ~ '^[A-Z]{1,2}[0-9][0-9A-Z]?$'),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  primary key (user_id, district)
);
create index on food.area_waitlist (district) where notified_at is null;
alter table food.area_waitlist enable row level security;
grant select, delete on food.area_waitlist to authenticated;
create policy "waitlist: own" on food.area_waitlist for select to authenticated using (user_id = auth.uid());
create policy "waitlist: leave" on food.area_waitlist for delete to authenticated using (user_id = auth.uid());

create function food.join_waitlist(p_postcode text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_district text := food.postcode_district(p_postcode);
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if v_district is null or v_district !~ '^[A-Z]{1,2}[0-9][0-9A-Z]?$' then
    raise exception 'That doesn''t look like a UK postcode';
  end if;
  if (select count(*) from food.area_waitlist where user_id = auth.uid()) >= 5 then
    raise exception 'You''re already waiting for 5 areas';
  end if;
  insert into food.area_waitlist (user_id, district) values (auth.uid(), v_district)
  on conflict (user_id, district) do update set notified_at = null;
  return v_district;
end $$;
revoke execute on function food.join_waitlist(text) from public, anon;
grant execute on function food.join_waitlist(text) to authenticated;

-- When a shop goes live, tell people waiting in its postcode area (once).
create function food.notify_waitlist() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_district text;
begin
  if new.status = 'live' and old.status is distinct from 'live' and not new.is_demo then
    select food.postcode_district(postcode) into v_district from food.shop_private where shop_id = new.id;
    if v_district is not null then
      insert into food.notifications (user_id, title, body, link)
      select w.user_id, 'A cook near you is on BiteBY', left(new.name || ' just opened in ' || v_district || '. Have a look at the menu.', 300), '/s/' || new.slug
        from food.area_waitlist w where w.district = v_district and w.notified_at is null;
      update food.area_waitlist set notified_at = now() where district = v_district and notified_at is null;
    end if;
  end if;
  return new;
end $$;
create trigger shops_notify_waitlist after update of status on food.shops
  for each row execute function food.notify_waitlist();

-- Where people are waiting, busiest areas first.
create function food.admin_waitlist() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.waiting desc, x.district) from (
      select district, count(*) filter (where notified_at is null) as waiting, count(*) as total, max(created_at) as latest
        from food.area_waitlist group by district
       order by 2 desc, 1
       limit 200
    ) x), '[]'::jsonb);
end $$;
revoke execute on function food.admin_waitlist() from public, anon;
grant execute on function food.admin_waitlist() to authenticated;

-- ---------- Announcements from the BiteBY team ----------
create table food.announcements (
  id bigint generated always as identity primary key,
  audience text not null check (audience in ('everyone', 'customers', 'cooks')),
  title text not null check (char_length(title) between 3 and 120),
  body text check (char_length(body) <= 300),
  link text check (char_length(link) <= 200),
  recipients int not null default 0,
  sent_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table food.announcements enable row level security;
grant select on food.announcements to authenticated;
create policy "announcements: admins" on food.announcements for select to authenticated using (food.is_admin());

create function food.admin_announce(p_audience text, p_title text, p_body text default null, p_link text default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := nullif(btrim(coalesce(p_body, '')), '');
  v_link text := nullif(btrim(coalesce(p_link, '')), '');
  v_count int;
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if p_audience not in ('everyone', 'customers', 'cooks') then raise exception 'Choose who it''s for'; end if;
  if char_length(v_title) < 3 then raise exception 'Add a title'; end if;
  if v_link is not null and v_link !~ '^/[A-Za-z0-9/_?=&.-]*$' then
    raise exception 'The link must be a page in the app, starting with /';
  end if;
  if (select count(*) from food.announcements where created_at > now() - interval '1 day') >= 5 then
    raise exception 'That''s 5 announcements today. Try again tomorrow.';
  end if;
  insert into food.notifications (user_id, title, body, link)
  select u.id, left(v_title, 120), left(v_body, 300), coalesce(v_link, '/alerts')
    from auth.users u
   where u.deleted_at is null
     and case p_audience
           when 'cooks' then exists (select 1 from food.seller_accounts a where a.user_id = u.id)
           when 'customers' then not exists (select 1 from food.seller_accounts a where a.user_id = u.id)
           else true end;
  get diagnostics v_count = row_count;
  insert into food.announcements (audience, title, body, link, recipients, sent_by)
  values (p_audience, left(v_title, 120), left(v_body, 300), v_link, v_count, auth.uid());
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'announcement', 'announcements', p_audience, jsonb_build_object('title', v_title, 'recipients', v_count));
  return v_count;
end $$;
revoke execute on function food.admin_announce(text, text, text, text) from public, anon;
grant execute on function food.admin_announce(text, text, text, text) to authenticated;
