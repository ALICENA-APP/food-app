-- Discount codes cooks make for their own shop (the cook pays for the discount),
-- customer reports on shops and dishes, and admin tools to pause or restore a shop.

-- ---------- Discount codes ----------
create table food.shop_discounts (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9]{3,20}$'),
  kind text not null check (kind in ('percent', 'amount')),
  value int not null check (value > 0),
  min_spend_pence int not null default 0 check (min_spend_pence between 0 and 100000),
  new_customers_only boolean not null default false,
  max_uses int check (max_uses between 1 and 10000),
  ends_on date,
  show_on_shop boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check ((kind = 'percent' and value between 1 and 50) or (kind = 'amount' and value between 50 and 5000))
);
create unique index on food.shop_discounts (shop_id, code);
alter table food.shop_discounts enable row level security;
grant select on food.shop_discounts to anon, authenticated;
grant insert (id, shop_id, code, kind, value, min_spend_pence, new_customers_only, max_uses, ends_on, show_on_shop, active)
  on food.shop_discounts to authenticated;
grant update (min_spend_pence, new_customers_only, max_uses, ends_on, show_on_shop, active) on food.shop_discounts to authenticated;
grant delete on food.shop_discounts to authenticated;
create policy "discounts: public reads shown offers" on food.shop_discounts for select
  using (show_on_shop and active and (ends_on is null or ends_on >= (now() at time zone 'Europe/London')::date) and food.shop_is_public(shop_id));
create policy "discounts: owner or admin reads" on food.shop_discounts for select to authenticated
  using (food.owns_shop(shop_id) or food.is_admin());
create policy "discounts: owner adds" on food.shop_discounts for insert to authenticated
  with check (food.owns_shop(shop_id) and (select count(*) from food.shop_discounts d where d.shop_id = shop_discounts.shop_id) < 20);
create policy "discounts: owner edits" on food.shop_discounts for update to authenticated
  using (food.owns_shop(shop_id)) with check (food.owns_shop(shop_id));
create policy "discounts: owner removes" on food.shop_discounts for delete to authenticated
  using (food.owns_shop(shop_id));

alter table food.orders
  add column discount_id uuid references food.shop_discounts (id) on delete set null,
  add column discount_code text check (char_length(discount_code) <= 20),
  add column discount_pence int not null default 0 check (discount_pence >= 0);
create index on food.orders (discount_id) where discount_id is not null;

-- Orders that count as using a code (not ones that fell through).
create function food.order_counts(p_status food.order_status) returns boolean
language sql immutable set search_path = '' as $$
  select p_status not in ('declined', 'cancelled', 'expired', 'refunded')
$$;

create function food.discount_amount(d food.shop_discounts, p_subtotal int) returns int
language sql immutable set search_path = '' as $$
  select case when d.id is null then 0
              when d.kind = 'percent' then least(p_subtotal, round(p_subtotal * d.value / 100.0)::int)
              else least(p_subtotal, d.value) end
$$;

-- Checks a code for this shop and basket and returns it, or explains why not.
create function food.check_discount_code(p_shop uuid, p_code text, p_subtotal int, p_user uuid, p_lock boolean default false)
returns food.shop_discounts
language plpgsql security definer set search_path = '' as $$
declare
  d food.shop_discounts;
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g'));
begin
  if p_lock then
    select * into d from food.shop_discounts where shop_id = p_shop and code = v_code for update;
  else
    select * into d from food.shop_discounts where shop_id = p_shop and code = v_code;
  end if;
  if not found or not d.active then
    raise exception 'That code doesn''t work at this shop';
  end if;
  if d.ends_on is not null and d.ends_on < (now() at time zone 'Europe/London')::date then
    raise exception 'That code has ended';
  end if;
  if p_subtotal < d.min_spend_pence then
    raise exception 'Spend £% on food to use this code', to_char(d.min_spend_pence / 100.0, 'FM999990.00');
  end if;
  if d.max_uses is not null and (select count(*) from food.orders o where o.discount_id = d.id and food.order_counts(o.status)) >= d.max_uses then
    raise exception 'That code has been used up';
  end if;
  if p_user is not null then
    if exists (select 1 from food.orders o where o.discount_id = d.id and o.customer_id = p_user and food.order_counts(o.status)) then
      raise exception 'You''ve already used this code';
    end if;
    if d.new_customers_only and exists (
      select 1 from food.orders o where o.shop_id = p_shop and o.customer_id = p_user and food.order_counts(o.status)
        and o.status <> 'awaiting_payment') then
      raise exception 'This code is for first orders from this cook';
    end if;
  end if;
  return d;
end $$;
revoke execute on function food.check_discount_code(uuid, text, int, uuid, boolean) from public, anon, authenticated;

-- For the basket: how much a code takes off.
create function food.preview_discount(p_shop uuid, p_code text, p_subtotal int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  d food.shop_discounts;
begin
  d := food.check_discount_code(p_shop, p_code, greatest(0, p_subtotal), auth.uid());
  return jsonb_build_object('code', d.code, 'kind', d.kind, 'value', d.value,
                            'discount_pence', food.discount_amount(d, greatest(0, p_subtotal)));
end $$;
revoke execute on function food.preview_discount(uuid, text, int) from public;
grant execute on function food.preview_discount(uuid, text, int) to anon, authenticated;

drop function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision);
create function food.place_order(
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
  select commission_bps into v_rate from food.platform_settings where id = 1;

  -- A cook's discount code comes off the food. BiteBY's fee is on what the
  -- customer actually pays for the food.
  if nullif(btrim(p_discount_code), '') is not null then
    select d.* into v_discount from food.check_discount_code(p_shop, p_discount_code, v_subtotal, auth.uid(), true) d;
    v_off := food.discount_amount(v_discount, v_subtotal);
  end if;

  update food.orders
     set subtotal_pence = v_subtotal,
         discount_id = v_discount.id,
         discount_code = v_discount.code,
         discount_pence = v_off,
         total_pence = v_subtotal - v_off + v_fee,
         platform_fee_pence = round((v_subtotal - v_off) * coalesce(v_rate, 1000) / 10000.0)
   where id = v_order;
  return v_order;
end $$;
revoke execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision, text) from public, anon;
grant execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision, text) to authenticated;

-- ---------- Reports from customers ----------
alter table food.safety_flags add column product_id uuid references food.products (id) on delete set null;

create function food.report_listing(p_shop uuid, p_product uuid, p_reason text, p_details text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_label text;
  v_name text;
begin
  if v_user is null then raise exception 'Sign in to report'; end if;
  v_label := case p_reason
    when 'off_app' then 'Report: asked to pay outside BiteBY'
    when 'unsafe' then 'Report: food safety worry'
    when 'allergens' then 'Report: wrong allergen information'
    when 'offensive' then 'Report: offensive or not allowed'
    when 'fake' then 'Report: fake or misleading'
    when 'other' then 'Report: something else' end;
  if v_label is null then raise exception 'Choose a reason'; end if;
  select name into v_name from food.shops where id = p_shop;
  if v_name is null then raise exception 'Shop not found'; end if;
  if p_product is not null and not exists (select 1 from food.products where id = p_product and shop_id = p_shop) then
    raise exception 'Dish not found';
  end if;
  if (select count(*) from food.safety_flags where user_id = v_user and source = 'report' and created_at > now() - interval '1 day') >= 10 then
    raise exception 'You''ve sent a lot of reports today. We''ll look at those first.';
  end if;
  insert into food.safety_flags (user_id, shop_id, product_id, source, reason, excerpt)
  values (v_user, p_shop, p_product, 'report', v_label, nullif(left(btrim(coalesce(p_details, '')), 300), ''));
  insert into food.notifications (user_id, title, body, link)
  select a.user_id, left(v_label || ' · ' || v_name, 120), left(nullif(btrim(coalesce(p_details, '')), ''), 300), '/admin?tab=safety'
    from food.app_admins a where a.revoked_at is null;
end $$;
revoke execute on function food.report_listing(uuid, uuid, text, text) from public, anon;
grant execute on function food.report_listing(uuid, uuid, text, text) to authenticated;

-- The Safety list gains the shop's state and the dish, so admins can act on it.
create or replace function food.admin_safety_flags() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select f.id, f.source, f.reason, f.excerpt, f.created_at, f.shop_id, s.name as shop_name, s.slug, s.status as shop_status,
             p.name as product_name, o.code as order_code, u.email,
             (select count(*) from food.safety_flags f2 where f2.shop_id = f.shop_id) as shop_total
        from food.safety_flags f
        left join food.shops s on s.id = f.shop_id
        left join food.products p on p.id = f.product_id
        left join food.orders o on o.id = f.order_id
        left join auth.users u on u.id = f.user_id
       order by f.created_at desc
       limit 200
    ) x), '[]'::jsonb);
end $$;

-- ---------- Admin: pause, suspend or restore a shop ----------
-- 'paused' gives the shop back to the cook, who can make it live again.
create or replace function food.admin_set_shop_status(p_shop uuid, p_status food.shop_status, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before food.shop_status;
  v_user uuid;
  v_name text;
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if p_status = 'live' then
    raise exception 'Only the seller can make their shop live';
  end if;
  if p_status = 'suspended' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Add a note saying why';
  end if;
  select s.status, a.user_id, s.name into v_before, v_user, v_name
    from food.shops s join food.seller_accounts a on a.id = s.seller_account_id where s.id = p_shop;
  if not found then
    raise exception 'Shop not found';
  end if;
  update food.shops set status = p_status, accepting_orders = false where id = p_shop;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, before, after)
  values (auth.uid(), 'admin', 'shop_status_change', 'shops', p_shop::text, p_note,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
  if v_user is not null and v_before is distinct from p_status then
    insert into food.notifications (user_id, title, body, link)
    values (v_user,
            case p_status when 'suspended' then 'Your shop has been suspended'
                          when 'paused' then case when v_before = 'suspended' then 'Your shop can open again' else 'BiteBY paused your shop' end
                          else 'Your shop was changed' end,
            left(coalesce(nullif(btrim(p_note), ''),
                          case when p_status = 'paused' and v_before = 'suspended' then 'Go to Your shop and turn it back on when you''re ready.' end), 300),
            '/sell');
  end if;
end $$;

-- All shops for the admin Shops list, with reports and orders.
create function food.admin_shops(p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select s.id, s.name, s.slug, s.status, s.accepting_orders, s.is_demo, s.area_label, s.created_at,
             a.status as seller_status, u.email,
             (select count(*) from food.orders o where o.shop_id = s.id and o.paid_at is not null) as orders,
             (select count(*) from food.safety_flags f where f.shop_id = s.id) as flags,
             (select count(*) from food.safety_flags f where f.shop_id = s.id and f.source = 'report') as reports
        from food.shops s
        join food.seller_accounts a on a.id = s.seller_account_id
        left join auth.users u on u.id = a.user_id
       where p_search is null or btrim(p_search) = ''
          or s.name ilike '%' || btrim(p_search) || '%' or s.slug ilike '%' || btrim(p_search) || '%'
          or u.email ilike '%' || btrim(p_search) || '%'
       order by s.created_at desc
       limit 200
    ) x), '[]'::jsonb);
end $$;
revoke execute on function food.admin_shops(text) from public, anon;
grant execute on function food.admin_shops(text) to authenticated;
