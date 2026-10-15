-- Orders. Customers place them through food.place_order(), which works out
-- every price in the database, so a changed basket in the browser can't
-- change what is charged. Payment (Stripe) is added later: until then new
-- orders wait in 'awaiting_payment' and sellers don't see them.

create type food.order_status as enum (
  'awaiting_payment',    -- created, not paid yet (hidden from the seller)
  'pending_acceptance',  -- paid, waiting for the seller to accept
  'accepted', 'declined', 'ready', 'out_for_delivery', 'completed',
  'cancelled', 'expired', 'refunded'
);
create type food.fulfilment as enum ('collection', 'delivery');

create table food.orders (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  customer_id uuid not null references auth.users (id) on delete restrict,
  shop_id uuid not null references food.shops (id) on delete restrict,
  status food.order_status not null default 'awaiting_payment',
  fulfilment food.fulfilment not null,
  requested_for timestamptz,
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  customer_phone text check (char_length(customer_phone) <= 30),
  customer_note text check (char_length(customer_note) <= 500),
  delivery_address text check (char_length(delivery_address) <= 300),
  delivery_postcode text check (char_length(delivery_postcode) <= 10),
  subtotal_pence integer not null check (subtotal_pence >= 0),
  delivery_fee_pence integer not null default 0 check (delivery_fee_pence >= 0),
  total_pence integer not null check (total_pence >= 0),
  platform_fee_pence integer not null check (platform_fee_pence >= 0),  -- 5% of food only
  stripe_payment_intent_id text unique,
  decline_reason text check (char_length(decline_reason) <= 300),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  accepted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check ((fulfilment = 'delivery') = (delivery_address is not null))
);
create index on food.orders (customer_id, created_at desc);
create index on food.orders (shop_id, created_at desc);
create trigger orders_touch before update on food.orders
  for each row execute function food.touch_updated_at();

-- Snapshot of each item as it was when ordered, including its allergens.
create table food.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references food.orders (id) on delete cascade,
  product_id uuid references food.products (id) on delete set null,
  product_version integer not null,
  name text not null,
  unit_price_pence integer not null,
  qty smallint not null check (qty between 1 and 50),
  line_total_pence integer not null,
  contains text[] not null default '{}',
  may_contain text[] not null default '{}'
);
create index on food.order_items (order_id);

alter table food.orders enable row level security;
alter table food.order_items enable row level security;
grant select on food.orders, food.order_items to authenticated;

create function food.can_see_order(p_order uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.orders o
    where o.id = p_order
      and (o.customer_id = auth.uid()
           or (o.status <> 'awaiting_payment' and food.owns_shop(o.shop_id))
           or food.is_admin())
  )
$$;
grant execute on function food.can_see_order(uuid) to authenticated;

create policy "orders: customer, seller (once paid) or admin" on food.orders
  for select to authenticated using (food.can_see_order(id));
create policy "order items: same as order" on food.order_items
  for select to authenticated using (food.can_see_order(order_id));

-- Postcode district, e.g. 'E3 2AB' -> 'E3'.
create function food.postcode_district(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(split_part(upper(trim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))), ' ', 1), '')
$$;

create function food.place_order(
  p_shop uuid,
  p_items jsonb,                -- [{"product_id": "...", "qty": 2}, ...]
  p_fulfilment food.fulfilment,
  p_customer_name text,
  p_customer_phone text default null,
  p_note text default null,
  p_requested_for timestamptz default null,
  p_delivery_address text default null,
  p_delivery_postcode text default null
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
    if not found then
      raise exception 'This shop does not deliver to that postcode';
    end if;
    v_fee := v_zone.fee_pence;
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

  if v_subtotal < coalesce(v_settings.min_order_pence, 0) then
    raise exception 'The minimum order is £%', to_char(v_settings.min_order_pence / 100.0, 'FM999990.00');
  end if;
  if p_fulfilment = 'delivery' and v_subtotal < v_zone.min_order_pence then
    raise exception 'The minimum order for delivery is £%', to_char(v_zone.min_order_pence / 100.0, 'FM999990.00');
  end if;

  update food.orders
     set subtotal_pence = v_subtotal,
         total_pence = v_subtotal + v_fee,
         platform_fee_pence = round(v_subtotal * 0.05)
   where id = v_order;
  return v_order;
end $$;
revoke execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text) from public, anon;
grant execute on function food.place_order(uuid, jsonb, food.fulfilment, text, text, text, timestamptz, text, text) to authenticated;

-- Customer cancels an order they haven't paid for yet.
create function food.cancel_unpaid_order(p_order uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update food.orders set status = 'cancelled'
   where id = p_order and customer_id = auth.uid() and status = 'awaiting_payment';
  if not found then
    raise exception 'This order can''t be cancelled here';
  end if;
end $$;
revoke execute on function food.cancel_unpaid_order(uuid) from public, anon;
grant execute on function food.cancel_unpaid_order(uuid) to authenticated;

-- Seller moves an order along. Paid orders only.
create function food.seller_update_order(
  p_order uuid, p_status food.order_status, p_reason text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order food.orders;
  v_ok boolean;
begin
  select * into v_order from food.orders where id = p_order for update;
  if not found or not food.owns_shop(v_order.shop_id) then
    raise exception 'Order not found';
  end if;
  v_ok := case v_order.status
    when 'pending_acceptance' then p_status in ('accepted', 'declined')
    when 'accepted' then p_status in ('ready', 'out_for_delivery', 'completed')
    when 'ready' then p_status in ('completed', 'out_for_delivery')
    when 'out_for_delivery' then p_status = 'completed'
    else false
  end;
  if not v_ok then
    raise exception 'Can''t change this order from % to %', v_order.status, p_status;
  end if;
  if p_status = 'declined' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Tell the customer why';
  end if;
  update food.orders
     set status = p_status,
         decline_reason = case when p_status = 'declined' then trim(p_reason) else decline_reason end,
         accepted_at = case when p_status = 'accepted' then now() else accepted_at end,
         completed_at = case when p_status = 'completed' then now() else completed_at end
   where id = p_order;
  -- Stock goes down when the seller accepts.
  if p_status = 'accepted' then
    update food.products p
       set stock_qty = greatest(p.stock_qty - i.qty, 0)
      from food.order_items i
     where i.order_id = p_order and i.product_id = p.id and p.stock_qty is not null;
  end if;
end $$;
revoke execute on function food.seller_update_order(uuid, food.order_status, text) from public, anon;
grant execute on function food.seller_update_order(uuid, food.order_status, text) to authenticated;

-- Collection address: shown to the customer only once the seller has
-- accepted their paid order.
create function food.order_collection_details(p_order uuid)
returns table (address_line1 text, address_line2 text, city text, postcode text,
               collection_instructions text, contact_phone text)
language sql stable security definer set search_path = '' as $$
  select p.address_line1, p.address_line2, p.city, p.postcode, p.collection_instructions, p.contact_phone
    from food.orders o
    join food.shop_private p on p.shop_id = o.shop_id
   where o.id = p_order and o.customer_id = auth.uid()
     and o.status in ('accepted', 'ready', 'out_for_delivery', 'completed')
$$;
revoke execute on function food.order_collection_details(uuid) from public, anon;
grant execute on function food.order_collection_details(uuid) to authenticated;
