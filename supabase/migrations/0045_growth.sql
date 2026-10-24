-- Growth batch (ALICENA chose all six, 24 Oct):
--  1. Stamp card: a cook can reward regulars ("your 6th order is 20% off").
--     The cook pays for it, like a discount code.
--  2. "Taking weekend orders" and "back from a break" nudges to followers.
--  3. Basket reminder: a gentle nudge when food is left in a basket.
--  4/5. ("How it works" strip, tell a friend who cooks) are app-only.
--  6. Suggested price for cooks adding a dish.

-- ---------------------------------------------------------------------------
-- 1. Stamp card
-- ---------------------------------------------------------------------------
create table food.shop_loyalty (
  shop_id uuid primary key references food.shops (id) on delete cascade,
  enabled boolean not null default true,
  stamps_needed smallint not null default 5 check (stamps_needed between 3 and 10),
  reward_percent smallint not null default 20 check (reward_percent between 5 and 50),
  updated_at timestamptz not null default now()
);
alter table food.shop_loyalty enable row level security;
grant select on food.shop_loyalty to anon, authenticated;
grant insert (shop_id, enabled, stamps_needed, reward_percent), update (enabled, stamps_needed, reward_percent) on food.shop_loyalty to authenticated;
create policy "stamp cards: public when on, owner always" on food.shop_loyalty
  for select using ((enabled and food.shop_is_public(shop_id)) or food.owns_shop(shop_id) or food.is_admin());
create policy "stamp cards: owner adds" on food.shop_loyalty for insert to authenticated with check (food.owns_shop(shop_id));
create policy "stamp cards: owner changes" on food.shop_loyalty for update to authenticated using (food.owns_shop(shop_id)) with check (food.owns_shop(shop_id));
create trigger shop_loyalty_touch before update on food.shop_loyalty
  for each row execute function food.touch_updated_at();

alter table food.orders add column loyalty_reward boolean not null default false;

-- Stamps: finished orders since the last reward was used. A reward order
-- that falls through (declined, cancelled, never paid) gives the reward back.
create function food.loyalty_stamps(p_shop uuid, p_user uuid) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from food.orders o
   where o.shop_id = p_shop and o.customer_id = p_user and o.status = 'completed' and not o.loyalty_reward
     and o.created_at > coalesce((
       select max(r.created_at) from food.orders r
        where r.shop_id = p_shop and r.customer_id = p_user and r.loyalty_reward
          and r.status not in ('declined', 'cancelled', 'expired', 'refunded')), '-infinity')
$$;
revoke execute on function food.loyalty_stamps(uuid, uuid) from public, anon, authenticated;

-- The customer's card for one shop (stamps only when signed in).
create function food.my_stamp_card(p_shop uuid) returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  c food.shop_loyalty;
  n int := 0;
begin
  select * into c from food.shop_loyalty where shop_id = p_shop and enabled;
  if not found or not food.shop_is_public(p_shop) then return null; end if;
  if auth.uid() is not null then n := least(food.loyalty_stamps(p_shop, auth.uid()), c.stamps_needed); end if;
  return json_build_object('needed', c.stamps_needed, 'percent', c.reward_percent, 'stamps', n, 'reward_ready', n >= c.stamps_needed);
end $$;
revoke execute on function food.my_stamp_card(uuid) from public;
grant execute on function food.my_stamp_card(uuid) to anon, authenticated;

create or replace function food.place_order(
  p_shop uuid,
  p_items jsonb,                -- [{"product_id": "...", "qty": 2}, ...]
  p_fulfilment food.fulfilment,
  p_customer_name text,
  p_customer_phone text default null,
  p_note text default null,
  p_requested_for timestamptz default null,
  p_delivery_address text default null,
  p_delivery_postcode text default null,
  p_lat double precision default null,  -- the delivery postcode's location, for shops that deliver by distance
  p_lng double precision default null,
  p_discount_code text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shop food.shops;
  v_settings food.shop_settings;
  v_zone food.shop_delivery_zones;
  v_order uuid := gen_random_uuid();
  v_item jsonb;
  v_product food.products;
  v_qty int;
  v_subtotal int := 0;
  v_fee int := 0;
  v_count int := 0;
  v_lead int := 0;
  v_private food.shop_private;
  v_min_delivery int := 0;
  v_rate int;
  v_variant food.product_variants;
  v_addon_ids uuid[];
  v_extras int;
  v_extra_names text;
  v_unit int;
  v_label text;
  v_found int;
  v_discount food.shop_discounts;
  v_off int := 0;
  v_card food.shop_loyalty;
  v_reward boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Sign in to order';
  end if;
  select * into v_shop from food.shops where id = p_shop;
  if not found or not food.shop_is_public(p_shop) then
    raise exception 'This shop is not open';
  end if;
  if not v_shop.accepting_orders then
    raise exception 'This shop is not taking orders right now';
  end if;
  select * into v_settings from food.shop_settings where shop_id = p_shop;
  if p_fulfilment = 'collection' and not coalesce(v_settings.offers_collection, true) then
    raise exception 'This shop does not offer collection';
  end if;
  if p_fulfilment = 'delivery' then
    if not coalesce(v_settings.offers_delivery, false) then
      raise exception 'This shop does not deliver';
    end if;
    if coalesce(trim(p_delivery_address), '') = '' then
      raise exception 'Add a delivery address';
    end if;
    select * into v_zone from food.shop_delivery_zones z
     where z.shop_id = p_shop and food.postcode_district(p_delivery_postcode) = any (z.postcode_districts)
     order by z.fee_pence limit 1;
    if found then
      v_fee := v_zone.fee_pence;
      v_min_delivery := v_zone.min_order_pence;
    else
      -- Or within the shop's delivery distance.
      select * into v_private from food.shop_private where shop_id = p_shop;
      if v_settings.delivery_radius_miles is null or v_private.lat is null or p_lat is null or p_lng is null
         or food.miles_between(v_private.lat, v_private.lng, p_lat, p_lng) > v_settings.delivery_radius_miles then
        raise exception 'This shop does not deliver to that postcode';
      end if;
      v_fee := v_settings.radius_fee_pence;
      v_min_delivery := v_settings.radius_min_order_pence;
    end if;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Your basket is empty';
  end if;

  insert into food.orders (id, customer_id, shop_id, fulfilment, requested_for, customer_name,
                           customer_phone, customer_note, delivery_address, delivery_postcode,
                           subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence)
  values (v_order, auth.uid(), p_shop, p_fulfilment, p_requested_for, trim(p_customer_name),
          nullif(trim(p_customer_phone), ''), nullif(trim(p_note), ''),
          case when p_fulfilment = 'delivery' then trim(p_delivery_address) end,
          case when p_fulfilment = 'delivery' then upper(trim(p_delivery_postcode)) end,
          0, v_fee, 0, 0);

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := (v_item ->> 'qty')::int;
    if v_qty is null or v_qty < 1 or v_qty > 50 then
      raise exception 'Choose between 1 and 50 of each item';
    end if;
    select * into v_product from food.products
     where id = (v_item ->> 'product_id')::uuid and shop_id = p_shop and status = 'published';
    if not found then
      raise exception 'An item in your basket is no longer available';
    end if;
    if p_fulfilment = 'collection' and not v_product.collection_ok
       or p_fulfilment = 'delivery' and not v_product.delivery_ok then
      raise exception '% is not available for %', v_product.name, p_fulfilment;
    end if;
    if v_product.stock_qty is not null then
      if v_product.stock_qty < v_qty then
        raise exception 'Only % left of %', v_product.stock_qty, v_product.name;
      end if;
    end if;
    -- The chosen size (required when the dish has sizes) and extras.
    v_variant := null;
    if exists (select 1 from food.product_variants where product_id = v_product.id) then
      select * into v_variant from food.product_variants
       where id = nullif(v_item ->> 'variant_id', '')::uuid and product_id = v_product.id;
      if not found then
        raise exception 'Choose an option for %', v_product.name;
      end if;
    end if;
    select coalesce(array_agg(distinct x::uuid), '{}') into v_addon_ids
      from jsonb_array_elements_text(coalesce(v_item -> 'addon_ids', '[]'::jsonb)) x;
    if cardinality(v_addon_ids) > 10 then
      raise exception 'Too many extras on %', v_product.name;
    end if;
    select count(*), coalesce(sum(price_pence), 0), string_agg(name, ', ' order by sort, name)
      into v_found, v_extras, v_extra_names
      from food.product_addons where product_id = v_product.id and id = any (v_addon_ids);
    if v_found <> cardinality(v_addon_ids) then
      raise exception 'An extra on % is no longer available', v_product.name;
    end if;
    v_unit := greatest(0, v_product.price_pence + coalesce(v_variant.price_delta_pence, 0) + v_extras);
    v_label := v_product.name || case
      when v_variant.id is null and v_extra_names is null then ''
      else ' (' || concat_ws(', ', v_variant.name, '+ ' || v_extra_names) || ')' end;

    insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence,
                                  qty, line_total_pence, contains, may_contain, variant_id, addon_ids)
    values (v_order, v_product.id, v_product.version, left(v_label, 200), v_unit,
            v_qty, v_unit * v_qty,
            coalesce((select array_agg(distinct allergen_code order by allergen_code) from food.product_allergens
                      where product_id = v_product.id and presence = 'contains'
                        and (variant_id is null or variant_id = v_variant.id)
                        and (addon_id is null or addon_id = any (v_addon_ids))), '{}'),
            coalesce((select array_agg(distinct allergen_code order by allergen_code) from food.product_allergens
                      where product_id = v_product.id and presence = 'may_contain'
                        and (variant_id is null or variant_id = v_variant.id)
                        and (addon_id is null or addon_id = any (v_addon_ids))), '{}'),
            v_variant.id, v_addon_ids);
    v_subtotal := v_subtotal + v_unit * v_qty;
    v_count := v_count + 1;
  end loop;

  -- Order-ahead: the time asked for must leave the cook enough notice.
  select coalesce(max(p.min_lead_hours), 0) into v_lead
    from food.products p
   where p.id in (select (e ->> 'product_id')::uuid from jsonb_array_elements(p_items) e);
  if p_requested_for is not null then
    if p_requested_for < now() - interval '5 minutes' then
      raise exception 'Choose a time in the future';
    end if;
    if p_requested_for > now() + interval '30 days' then
      raise exception 'You can order up to 30 days ahead';
    end if;
  end if;
  if v_lead > 0 then
    if p_requested_for is null then
      raise exception 'Some dishes need ordering % hours ahead. Choose a time for your order.', v_lead;
    end if;
    if p_requested_for < now() + make_interval(hours => v_lead) then
      raise exception 'Some dishes need ordering % hours ahead. Choose a later time.', v_lead;
    end if;
  end if;

  if v_subtotal < coalesce(v_settings.min_order_pence, 0) then
    raise exception 'The minimum order is £%', to_char(v_settings.min_order_pence / 100.0, 'FM999990.00');
  end if;
  if p_fulfilment = 'delivery' and v_subtotal < v_min_delivery then
    raise exception 'The minimum order for delivery is £%', to_char(v_min_delivery / 100.0, 'FM999990.00');
  end if;
  v_rate := food.shop_commission_bps(p_shop);

  -- A cook's discount code comes off the food. BiteBY's fee is on what the
  -- customer actually pays for the food.
  if nullif(btrim(p_discount_code), '') is not null then
    select d.* into v_discount from food.check_discount_code(p_shop, p_discount_code, v_subtotal, auth.uid(), true) d;
    v_off := food.discount_amount(v_discount, v_subtotal);
  end if;

  -- Stamp card: with no code used, a reward that's due comes off the food.
  -- A code keeps the reward for next time.
  if v_off = 0 then
    select * into v_card from food.shop_loyalty where shop_id = p_shop and enabled;
    if found and food.loyalty_stamps(p_shop, auth.uid()) >= v_card.stamps_needed then
      v_off := least(v_subtotal, round(v_subtotal * v_card.reward_percent / 100.0)::int);
      v_reward := v_off > 0;
    end if;
  end if;

  update food.orders
     set subtotal_pence = v_subtotal,
         discount_id = v_discount.id,
         discount_code = case when v_reward then 'Stamp card' else v_discount.code end,
         loyalty_reward = v_reward,
         discount_pence = v_off,
         service_fee_pence = food.service_fee(v_subtotal - v_off + v_fee),
         total_pence = v_subtotal - v_off + v_fee + food.service_fee(v_subtotal - v_off + v_fee),
         platform_fee_pence = round((v_subtotal - v_off) * coalesce(v_rate, 1000) / 10000.0)
   where id = v_order;
  return v_order;
end $$;

-- ---------------------------------------------------------------------------
-- 2. "Taking weekend orders" and "back from a break"
-- ---------------------------------------------------------------------------
create table food.follower_nudges (
  user_id uuid not null references auth.users (id) on delete cascade,
  shop_id uuid not null references food.shops (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);
alter table food.follower_nudges enable row level security;

-- People who follow the shop or ordered in the last 90 days, have cook
-- updates on, and haven't had one of these from this shop in a week.
create function food.nudge_followers(p_shop uuid, p_title text, p_body text) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_slug text;
  n int;
begin
  select slug into v_slug from food.shops where id = p_shop;
  with who as (
    select distinct u.id from (
      select f.user_id as id from food.favourites f
       where f.shop_id = p_shop or f.product_id in (select id from food.products where shop_id = p_shop)
      union
      select o.customer_id from food.orders o
       where o.shop_id = p_shop and o.paid_at is not null and o.created_at > now() - interval '90 days'
    ) u
    join food.profiles pr on pr.id = u.id and pr.cook_updates
    where u.id is distinct from food.shop_owner(p_shop)
      and not exists (select 1 from food.follower_nudges x where x.user_id = u.id and x.shop_id = p_shop and x.sent_at > now() - interval '7 days')
      -- Two of these a day at most, from all cooks together.
      and (select count(*) from food.follower_nudges y where y.user_id = u.id and y.sent_at > now() - interval '1 day') < 2
    limit 500
  ), logged as (
    insert into food.follower_nudges (user_id, shop_id) select id, p_shop from who
    on conflict (user_id, shop_id) do update set sent_at = now()
    returning user_id
  )
  insert into food.notifications (user_id, title, body, link)
  select user_id, left(p_title, 120), left(p_body, 300), '/s/' || v_slug from logged;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function food.nudge_followers(uuid, text, text) from public, anon, authenticated;

-- Fridays from 11:00 to 19:00: cooks open at the weekend who are taking orders.
create function food.weekend_nudges() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Europe/London';
  r record;
  n int := 0;
begin
  if extract(isodow from v_now) <> 5 or extract(hour from v_now) < 11 or extract(hour from v_now) >= 19 then return 0; end if;
  for r in
    select s.id, s.name from food.shops s
     where s.accepting_orders and food.shop_is_public(s.id) and not s.is_test
       and exists (select 1 from food.shop_hours h where h.shop_id = s.id and h.weekday in (5, 6))
       and not exists (select 1 from food.shop_closures c where c.shop_id = s.id
                        and c.closed_on in ((v_now)::date + 1, (v_now)::date + 2))
  loop
    n := n + food.nudge_followers(r.id, r.name || ' is taking weekend orders',
                                  'Order now for Saturday or Sunday, before the spots go.');
  end loop;
  return n;
end $$;
revoke execute on function food.weekend_nudges() from public, anon, authenticated;

-- Back from a break: orders switched back on after at least 2 days off.
alter table food.shops add column paused_since timestamptz;
create function food.shop_back_nudge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not new.accepting_orders and old.accepting_orders then
    new.paused_since := now();
  elsif new.accepting_orders and not old.accepting_orders then
    if old.paused_since < now() - interval '2 days' and food.shop_is_public(new.id) then
      perform food.nudge_followers(new.id, new.name || ' is back', 'Taking orders again. See what''s cooking.');
    end if;
    new.paused_since := null;
  end if;
  return new;
end $$;
create trigger shops_back_nudge before update of accepting_orders on food.shops
  for each row execute function food.shop_back_nudge();

-- ---------------------------------------------------------------------------
-- 3. Basket reminder
-- ---------------------------------------------------------------------------
-- The signed-in person's basket, saved so a reminder can be sent (and the
-- basket opened on another phone). One row each, removed when emptied.
create table food.saved_baskets (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  shop_id uuid not null references food.shops (id) on delete cascade,
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 30 and pg_column_size(lines) < 8000),
  item_count int not null check (item_count between 1 and 500),
  updated_at timestamptz not null default now(),
  reminded_at timestamptz
);
alter table food.saved_baskets enable row level security;
grant select, delete on food.saved_baskets to authenticated;
create policy "saved basket: own" on food.saved_baskets for select to authenticated using (user_id = auth.uid());
create policy "saved basket: remove own" on food.saved_baskets for delete to authenticated using (user_id = auth.uid());

create function food.save_basket(p_shop uuid, p_lines jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    delete from food.saved_baskets where user_id = auth.uid();
    return;
  end if;
  insert into food.saved_baskets (user_id, shop_id, lines, item_count)
  values (auth.uid(), p_shop, p_lines,
          greatest(1, least(500, (select coalesce(sum((l ->> 'qty')::int), 1) from jsonb_array_elements(p_lines) l))))
  on conflict (user_id) do update
    set shop_id = excluded.shop_id, lines = excluded.lines, item_count = excluded.item_count, updated_at = now(),
        reminded_at = case when food.saved_baskets.shop_id = excluded.shop_id then food.saved_baskets.reminded_at end;
end $$;
revoke execute on function food.save_basket(uuid, jsonb) from public, anon;
grant execute on function food.save_basket(uuid, jsonb) to authenticated;

-- An order clears the saved basket.
create function food.clear_saved_basket() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from food.saved_baskets where user_id = new.customer_id;
  return null;
end $$;
create trigger orders_clear_basket after insert on food.orders
  for each row execute function food.clear_saved_basket();

-- One reminder per basket, 3 to 24 hours after it was last changed, in the
-- daytime, and only if the shop is still taking orders.
create function food.basket_reminders() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_hour int := extract(hour from now() at time zone 'Europe/London');
  n int;
begin
  if v_hour < 10 or v_hour >= 20 then return 0; end if;
  with due as (
    update food.saved_baskets b set reminded_at = now()
      from food.shops s, food.profiles pr
     where s.id = b.shop_id and pr.id = b.user_id and pr.cook_updates
       and b.reminded_at is null
       and b.updated_at between now() - interval '24 hours' and now() - interval '3 hours'
       and s.accepting_orders and food.shop_is_public(s.id)
    returning b.user_id, b.item_count, s.name
  )
  insert into food.notifications (user_id, title, body, link)
  select user_id, left('Your food from ' || name || ' is still in your basket', 120),
         case when item_count = 1 then '1 item is waiting. Order before it sells out.' else item_count || ' items are waiting. Order before they sell out.' end,
         '/basket'
    from due;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function food.basket_reminders() from public, anon, authenticated;

-- The job runner also sends these.
create or replace function food.run_jobs(p_source text default 'app') returns text
language plpgsql security definer set search_path = '' as $$
declare
  j food.job_runs;
  v_source text := case when p_source in ('cron', 'netlify', 'app', 'github') then p_source else 'app' end;
begin
  select * into j from food.job_runs where id = 1 for update skip locked;
  if not found or j.last_run > now() - interval '50 seconds' then return 'skipped'; end if;
  update food.job_runs
     set last_run = now(), last_source = v_source,
         sources = sources || jsonb_build_object(v_source, now())
   where id = 1;
  perform food.expire_stale_orders();
  perform food.order_reminders();
  perform food.escalate_old_issues();
  if j.last_hourly is null or j.last_hourly < now() - interval '1 hour' then
    update food.job_runs set last_hourly = now() where id = 1;
    perform food.send_reorder_nudges();
    perform food.weekend_nudges();
    perform food.basket_reminders();
    perform food.insurance_reminders();
    perform food.tax_details_reminders();
  end if;
  return 'ran';
end $$;

-- ---------------------------------------------------------------------------
-- 6. Suggested price
-- ---------------------------------------------------------------------------
-- What similar dishes sell for: same category, and a shared word in the
-- name when there are enough of those. Only shown from 3 dishes up.
create function food.price_hint(p_category uuid, p_name text) returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  v_words text[] := array(select w from regexp_split_to_table(lower(coalesce(p_name, '')), '[^a-z]+') w where char_length(w) >= 4);
  r record;
begin
  select count(*)::int as n,
         percentile_cont(0.25) within group (order by p.price_pence) as low,
         percentile_cont(0.5) within group (order by p.price_pence) as mid,
         percentile_cont(0.75) within group (order by p.price_pence) as high
    into r
    from food.products p
   where p.status = 'published' and food.shop_is_public(p.shop_id)
     and cardinality(v_words) > 0
     and exists (select 1 from unnest(v_words) w where lower(p.name) like '%' || w || '%');
  if r.n >= 3 then
    return json_build_object('basis', 'name', 'count', r.n, 'low', round(r.low), 'mid', round(r.mid), 'high', round(r.high));
  end if;
  if p_category is null then return null; end if;
  select count(*)::int as n,
         percentile_cont(0.25) within group (order by p.price_pence) as low,
         percentile_cont(0.5) within group (order by p.price_pence) as mid,
         percentile_cont(0.75) within group (order by p.price_pence) as high
    into r
    from food.products p
   where p.status = 'published' and p.category_id = p_category and food.shop_is_public(p.shop_id);
  if r.n >= 3 then
    return json_build_object('basis', 'category', 'count', r.n, 'low', round(r.low), 'mid', round(r.mid), 'high', round(r.high));
  end if;
  return null;
end $$;
revoke execute on function food.price_hint(uuid, text) from public, anon;
grant execute on function food.price_hint(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Demo: every demo cook has a stamp card, so it shows in the app.
-- ---------------------------------------------------------------------------
insert into food.shop_loyalty (shop_id, stamps_needed, reward_percent)
select id, case when row_number() over (order by name) % 2 = 0 then 5 else 6 end, case when row_number() over (order by name) % 2 = 0 then 20 else 15 end
  from food.shops where is_demo
on conflict (shop_id) do nothing;
