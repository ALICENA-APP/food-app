-- Commission as a setting (now 10% of food, decided by ALICENA on
-- 16 Oct 2026), and delivery by distance: a seller can deliver within a set
-- number of miles of their home, and customers can find cooks near them.

create table food.platform_settings (
  id smallint primary key default 1 check (id = 1),
  commission_bps integer not null check (commission_bps between 0 and 5000)  -- 1000 = 10%
);
insert into food.platform_settings (id, commission_bps) values (1, 1000);
alter table food.platform_settings enable row level security;
grant select on food.platform_settings to anon, authenticated;
create policy "platform settings are public" on food.platform_settings for select using (true);

-- Shop location: kept private (owner and admins only), like the address.
alter table food.shop_private add column lat double precision check (lat between 49 and 61),
                              add column lng double precision check (lng between -9 and 3);
alter table food.shop_settings
  add column delivery_radius_miles numeric(4, 1) check (delivery_radius_miles between 0.5 and 20),
  add column radius_fee_pence integer not null default 0 check (radius_fee_pence between 0 and 10000),
  add column radius_min_order_pence integer not null default 0 check (radius_min_order_pence between 0 and 100000);
grant insert (lat, lng), update (lat, lng) on food.shop_private to authenticated;
grant insert (delivery_radius_miles, radius_fee_pence, radius_min_order_pence),
      update (delivery_radius_miles, radius_fee_pence, radius_min_order_pence) on food.shop_settings to authenticated;

create function food.miles_between(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision
language sql immutable set search_path = '' as $$
  select 3958.8 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- Live shops near a point. Distances are rounded to whole miles (never
-- more exact), so a cook's home can't be pinpointed.
create function food.shops_near(p_lat double precision, p_lng double precision, p_miles double precision default 5)
returns table (shop_id uuid, miles integer, delivers boolean, fee_pence integer)
language sql stable security definer set search_path = '' as $$
  select s.id,
         greatest(1, round(food.miles_between(p.lat, p.lng, p_lat, p_lng)))::int,
         st.offers_delivery and st.delivery_radius_miles is not null
           and food.miles_between(p.lat, p.lng, p_lat, p_lng) <= st.delivery_radius_miles,
         st.radius_fee_pence
    from food.shops s
    join food.shop_private p on p.shop_id = s.id
    left join food.shop_settings st on st.shop_id = s.id
   where food.shop_is_public(s.id) and p.lat is not null
     and food.miles_between(p.lat, p.lng, p_lat, p_lng) <= least(greatest(p_miles, 0.5), 20)
$$;
grant execute on function food.shops_near(double precision, double precision, double precision) to anon, authenticated;

drop function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text);
-- Same as before, plus delivery by distance and the commission from settings.
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
  p_lng double precision default null
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
    insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence,
                                  qty, line_total_pence, contains, may_contain)
    values (v_order, v_product.id, v_product.version, v_product.name, v_product.price_pence,
            v_qty, v_product.price_pence * v_qty,
            coalesce((select array_agg(allergen_code order by allergen_code) from food.product_allergens
                      where product_id = v_product.id and variant_id is null and addon_id is null
                        and presence = 'contains'), '{}'),
            coalesce((select array_agg(allergen_code order by allergen_code) from food.product_allergens
                      where product_id = v_product.id and variant_id is null and addon_id is null
                        and presence = 'may_contain'), '{}'));
    v_subtotal := v_subtotal + v_product.price_pence * v_qty;
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

  update food.orders
     set subtotal_pence = v_subtotal,
         total_pence = v_subtotal + v_fee,
         platform_fee_pence = round(v_subtotal * coalesce(v_rate, 1000) / 10000.0)
   where id = v_order;
  return v_order;
end $$;
revoke execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision) from public, anon;
grant execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision) to authenticated;
