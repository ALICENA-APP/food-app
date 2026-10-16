-- Dish options (one choice such as Size, plus optional extras), shop
-- announcements, and alerts to followers when a cook adds a new dish.

-- What was chosen, so "Order again" can rebuild the same dish.
alter table food.order_items
  add column variant_id uuid,
  add column addon_ids uuid[] not null default '{}';

-- A short message on the shop page, e.g. "Jerk chicken this Saturday only".
alter table food.shops
  add column notice text check (char_length(notice) <= 160),
  add column notice_until date;
grant update (notice, notice_until) on food.shops to authenticated;

-- Orders now take {"product_id", "qty", "variant_id", "addon_ids"} per line.
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
  v_variant food.product_variants;
  v_addon_ids uuid[];
  v_extras int;
  v_extra_names text;
  v_unit int;
  v_label text;
  v_found int;
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

  update food.orders
     set subtotal_pence = v_subtotal,
         total_pence = v_subtotal + v_fee,
         platform_fee_pence = round(v_subtotal * coalesce(v_rate, 1000) / 10000.0)
   where id = v_order;
  return v_order;
end $$;

revoke execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision) from public, anon;
grant execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text, double precision, double precision) to authenticated;

-- Followers hear about a cook's new dishes, once per dish.
create table food.product_announcements (
  product_id uuid primary key references food.products (id) on delete cascade,
  announced_at timestamptz not null default now()
);
alter table food.product_announcements enable row level security;

create function food.announce_new_dish() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_shop food.shops;
begin
  if new.status <> 'published' then return null; end if;
  select * into v_shop from food.shops where id = new.shop_id;
  if v_shop.status <> 'live' then return null; end if;
  insert into food.product_announcements (product_id) values (new.id) on conflict do nothing;
  if not found then return null; end if;
  insert into food.notifications (user_id, title, body, link)
  select f.user_id, 'New from ' || left(v_shop.name, 100), left(new.name, 300), '/s/' || v_shop.slug || '/i/' || new.id
    from food.favourites f
   where f.shop_id = new.shop_id
     and f.user_id <> (select sa.user_id from food.seller_accounts sa where sa.id = v_shop.seller_account_id);
  return null;
end $$;
create trigger products_announce after insert or update of status on food.products
  for each row execute function food.announce_new_dish();

-- Dishes already on sale don't trigger alerts when this goes live.
insert into food.product_announcements (product_id)
select id from food.products where status = 'published' on conflict do nothing;
