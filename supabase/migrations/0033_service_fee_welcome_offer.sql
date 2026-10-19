-- Fees, made simple and clear:
-- * Customers pay a small "Service fee" that covers the card payment cost
--   (Stripe's 1.5% + 20p, worked out on the whole payment), the same however
--   they pay. So cooks get exactly the food price minus BiteBY's fee.
-- * New cooks pay a lower BiteBY fee (5% instead of 10%) for their first
--   month, counted from their first paid order so nobody loses days while
--   setting up.
-- All numbers are in Admin > Settings.

alter table food.platform_settings
  add column if not exists intro_commission_bps integer not null default 500 check (intro_commission_bps between 0 and 5000),
  add column if not exists intro_days integer not null default 30 check (intro_days between 0 and 365),
  add column if not exists service_fee_bps integer not null default 150 check (service_fee_bps between 0 and 1000),
  add column if not exists service_fee_fixed_pence integer not null default 20 check (service_fee_fixed_pence between 0 and 200);

-- Paid by the customer on top of the order. Never part of the cook's money.
alter table food.orders add column if not exists service_fee_pence integer not null default 0 check (service_fee_pence >= 0);

-- The service fee for an order worth p_base (food after discount + delivery):
-- what the card cost on the whole payment comes to, to the nearest penny.
create or replace function food.service_fee(p_base integer) returns integer
language sql stable security definer set search_path = '' as $$
  select case when coalesce(p_base, 0) <= 0 then 0
         else round((p_base * s.service_fee_bps / 10000.0 + s.service_fee_fixed_pence) / (1 - s.service_fee_bps / 10000.0))::int end
    from food.platform_settings s where s.id = 1
$$;
grant execute on function food.service_fee(integer) to anon, authenticated;

-- When a shop's welcome rate ends: 30 days after its first paid order, or
-- null if it has no paid order yet (so the welcome rate hasn't started).
create or replace function food.shop_intro_ends(p_shop uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select min(o.created_at) + make_interval(days => (select intro_days from food.platform_settings where id = 1))
    from food.orders o
   where o.shop_id = p_shop and o.status not in ('awaiting_payment', 'expired')
$$;
revoke execute on function food.shop_intro_ends(uuid) from public;

-- The BiteBY fee rate for a shop's next order.
create or replace function food.shop_commission_bps(p_shop uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when coalesce(food.shop_intro_ends(p_shop) > now(), true) and s.intro_days > 0
              then least(s.intro_commission_bps, s.commission_bps) else s.commission_bps end
    from food.platform_settings s where s.id = 1
$$;
revoke execute on function food.shop_commission_bps(uuid) from public;

-- For the cook's own screens: their rate now and when the welcome rate ends.
create or replace function food.my_fee_rate(p_shop uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s food.platform_settings;
  v_ends timestamptz;
begin
  if not food.owns_shop(p_shop) then raise exception 'Not your shop'; end if;
  select * into s from food.platform_settings where id = 1;
  v_ends := food.shop_intro_ends(p_shop);
  return jsonb_build_object(
    'rate_bps', food.shop_commission_bps(p_shop),
    'standard_bps', s.commission_bps,
    'intro_bps', least(s.intro_commission_bps, s.commission_bps),
    'intro_days', s.intro_days,
    'intro_started', v_ends is not null,
    'intro_ends_at', v_ends);
end $$;
revoke execute on function food.my_fee_rate(uuid) from public, anon;
grant execute on function food.my_fee_rate(uuid) to authenticated;

create or replace function food.admin_set_service_fee(p_bps integer, p_fixed integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_bps not between 0 and 1000 then raise exception 'The service fee must be between 0%% and 10%%'; end if;
  if p_fixed not between 0 and 200 then raise exception 'The fixed part must be between 0p and 200p'; end if;
  update food.platform_settings set service_fee_bps = p_bps, service_fee_fixed_pence = p_fixed where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'service_fee', 'platform_settings', '1', jsonb_build_object('service_fee_bps', p_bps, 'service_fee_fixed_pence', p_fixed));
end $$;
revoke execute on function food.admin_set_service_fee(integer, integer) from public, anon;
grant execute on function food.admin_set_service_fee(integer, integer) to authenticated;

create or replace function food.admin_set_intro_offer(p_bps integer, p_days integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_bps not between 0 and 3000 then raise exception 'The welcome fee must be between 0%% and 30%%'; end if;
  if p_days not between 0 and 365 then raise exception 'The welcome period must be between 0 and 365 days'; end if;
  update food.platform_settings set intro_commission_bps = p_bps, intro_days = p_days where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'intro_offer', 'platform_settings', '1', jsonb_build_object('intro_commission_bps', p_bps, 'intro_days', p_days));
end $$;
revoke execute on function food.admin_set_intro_offer(integer, integer) from public, anon;
grant execute on function food.admin_set_intro_offer(integer, integer) to authenticated;

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

  update food.orders
     set subtotal_pence = v_subtotal,
         discount_id = v_discount.id,
         discount_code = v_discount.code,
         discount_pence = v_off,
         service_fee_pence = food.service_fee(v_subtotal - v_off + v_fee),
         total_pence = v_subtotal - v_off + v_fee + food.service_fee(v_subtotal - v_off + v_fee),
         platform_fee_pence = round((v_subtotal - v_off) * coalesce(v_rate, 1000) / 10000.0)
   where id = v_order;
  return v_order;
end $$;

