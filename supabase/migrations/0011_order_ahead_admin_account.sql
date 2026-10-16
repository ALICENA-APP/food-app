-- Order-ahead times, postcodes without a space, an admin overview and
-- account deletion.

-- "E32AA" and "E3 2AA" both give the district "E3".
create or replace function food.postcode_district(p text) returns text
language sql immutable set search_path = '' as $$
  select nullif(case
    when position(' ' in t) > 0 then split_part(t, ' ', 1)
    when length(t) >= 5 then left(t, length(t) - 3)
    else t end, '')
  from (select upper(trim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))) as t) x
$$;

-- Same as before, plus: a requested time can't be in the past or more than
-- 30 days away, and dishes that need notice (min_lead_hours) must be
-- ordered at least that far ahead.
create or replace function food.place_order(
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
  v_lead int := 0;
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

-- Numbers for the admin overview.
create function food.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return jsonb_build_object(
    'users', (select count(*) from auth.users),
    'new_users_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'sellers', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from food.seller_accounts group by status) s),
    'live_shops', (select count(*) from food.shops where status = 'live'),
    'dishes_on_sale', (select count(*) from food.products where status = 'published'),
    'orders_7d', (select count(*) from food.orders where created_at > now() - interval '7 days' and paid_at is not null),
    'orders_30d', (select count(*) from food.orders where created_at > now() - interval '30 days' and paid_at is not null),
    'sales_30d_pence', (select coalesce(sum(total_pence), 0) from food.orders where created_at > now() - interval '30 days' and status = 'completed'),
    'fees_30d_pence', (select coalesce(sum(platform_fee_pence), 0) from food.orders where created_at > now() - interval '30 days' and status = 'completed'),
    'open_orders', (select count(*) from food.orders where status in ('pending_acceptance', 'accepted', 'ready', 'out_for_delivery')),
    'reviews_30d', (select count(*) from food.reviews where created_at > now() - interval '30 days'),
    'deletion_requests', (select count(*) from food.account_deletions where done_at is null)
  );
end $$;

-- Account deletion: personal details are wiped straight away; the sign-in
-- itself is removed by an admin (it needs the Supabase dashboard). Orders and
-- reviews are kept, without personal details, so removing the sign-in must
-- not be blocked by them.
alter table food.orders alter column customer_id drop not null;
alter table food.orders drop constraint orders_customer_id_fkey,
  add constraint orders_customer_id_fkey foreign key (customer_id) references auth.users (id) on delete set null;
alter table food.reviews alter column customer_id drop not null;
alter table food.reviews drop constraint reviews_customer_id_fkey,
  add constraint reviews_customer_id_fkey foreign key (customer_id) references auth.users (id) on delete set null;
create table food.account_deletions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  requested_at timestamptz not null default now(),
  done_at timestamptz
);
alter table food.account_deletions enable row level security;
grant select on food.account_deletions to authenticated;
create policy "account deletions: admins" on food.account_deletions
  for select to authenticated using (food.is_admin());

revoke execute on function food.admin_overview() from public, anon;
grant execute on function food.admin_overview() to authenticated;

create function food.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from food.seller_accounts where user_id = v_user and status not in ('draft', 'rejected', 'removed')) then
    raise exception 'You have a seller account. Contact the BiteBY team to close your shop first.';
  end if;
  if exists (select 1 from food.orders where customer_id = v_user and status in ('pending_acceptance', 'accepted', 'ready', 'out_for_delivery')) then
    raise exception 'You have an order in progress. You can delete your account once it''s finished.';
  end if;
  update food.orders set status = 'cancelled' where customer_id = v_user and status = 'awaiting_payment';
  update food.orders
     set customer_name = 'Deleted customer', customer_phone = null, customer_note = null,
         delivery_address = case when delivery_address is null then null else 'Removed' end
   where customer_id = v_user;
  update food.reviews set reviewer_name = 'Former customer' where customer_id = v_user;
  update food.profiles set display_name = null, phone = null, marketing_consent = false, marketing_consent_at = null where id = v_user;
  delete from food.addresses where user_id = v_user;
  delete from food.favourites where user_id = v_user;
  delete from food.notifications where user_id = v_user;
  delete from food.order_messages where sender_id = v_user;
  insert into food.account_deletions (user_id) values (v_user) on conflict do nothing;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id)
  values (v_user, 'customer', 'account_deletion_requested', 'auth.users', v_user::text);
end $$;
revoke execute on function food.delete_my_account() from public, anon;
grant execute on function food.delete_my_account() to authenticated;

-- Admin: the deletion requests, with the email to remove in Supabase.
create function food.admin_deletion_requests() returns table (user_id uuid, email text, requested_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return query
    select d.user_id, u.email::text, d.requested_at
      from food.account_deletions d join auth.users u on u.id = d.user_id
     where d.done_at is null order by d.requested_at;
end $$;
revoke execute on function food.admin_deletion_requests() from public, anon;
grant execute on function food.admin_deletion_requests() to authenticated;
