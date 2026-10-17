-- A daily order limit for cooks, "popular" dishes, and back-in-stock alerts.

-- ---------- Daily order limit ----------
alter table food.shop_settings add column max_orders_per_day smallint check (max_orders_per_day between 1 and 500);
grant insert (max_orders_per_day), update (max_orders_per_day) on food.shop_settings to authenticated;

-- Orders that take up a place in the cook's day (not ones that fell through).
create function food.orders_on_day(p_shop uuid, p_day date) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from food.orders o
   where o.shop_id = p_shop
     and (coalesce(o.requested_for, o.created_at) at time zone 'Europe/London')::date = p_day
     and o.status not in ('declined', 'cancelled', 'expired', 'refunded')
$$;

create function food.check_daily_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_max int;
  v_day date := (coalesce(new.requested_for, now()) at time zone 'Europe/London')::date;
begin
  select max_orders_per_day into v_max from food.shop_settings where shop_id = new.shop_id;
  if v_max is not null and food.orders_on_day(new.shop_id, v_day) >= v_max then
    raise exception 'The cook is fully booked on %. Please choose another day.', to_char(v_day, 'FMDay FMDD FMMonth');
  end if;
  return new;
end $$;
create trigger orders_daily_limit before insert on food.orders
  for each row execute function food.check_daily_limit();

-- Days in the next two weeks a shop is fully booked (dates only, no counts).
create function food.shop_full_days(p_shop uuid) returns setof date
language sql stable security definer set search_path = '' as $$
  select d::date
    from generate_series((now() at time zone 'Europe/London')::date, (now() at time zone 'Europe/London')::date + 13, interval '1 day') d
    join food.shop_settings s on s.shop_id = p_shop and s.max_orders_per_day is not null
   where food.shop_is_public(p_shop)
     and food.orders_on_day(p_shop, d::date) >= s.max_orders_per_day
$$;
revoke execute on function food.shop_full_days(uuid) from public;
grant execute on function food.shop_full_days(uuid) to anon, authenticated;
revoke execute on function food.orders_on_day(uuid, date) from public, anon, authenticated;

-- ---------- Popular dishes ----------
-- How often each dish was ordered in the last 90 days, only from 3 orders up,
-- so small numbers about individual customers never show.
create function food.dish_order_counts(p_products uuid[]) returns table (product_id uuid, orders int)
language sql stable security definer set search_path = '' as $$
  select i.product_id, count(distinct i.order_id)::int
    from food.order_items i
    join food.orders o on o.id = i.order_id
   where i.product_id = any (p_products[1:200])
     and o.paid_at is not null
     and o.status not in ('declined', 'cancelled', 'expired', 'refunded')
     and o.created_at > now() - interval '90 days'
     and food.product_is_public(i.product_id)
   group by i.product_id
  having count(distinct i.order_id) >= 3
$$;
revoke execute on function food.dish_order_counts(uuid[]) from public;
grant execute on function food.dish_order_counts(uuid[]) to anon, authenticated;

-- ---------- Back-in-stock alerts ----------
create table food.stock_alerts (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  product_id uuid not null references food.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);
alter table food.stock_alerts enable row level security;
grant select, insert (product_id), delete on food.stock_alerts to authenticated;
create policy "stock alerts: own" on food.stock_alerts for select to authenticated using (user_id = auth.uid());
create policy "stock alerts: add" on food.stock_alerts for insert to authenticated
  with check (user_id = auth.uid() and (select count(*) from food.stock_alerts a where a.user_id = auth.uid()) < 50);
create policy "stock alerts: remove" on food.stock_alerts for delete to authenticated using (user_id = auth.uid());

-- When a dish can be ordered again, tell the people waiting for it (once).
create function food.notify_back_in_stock() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_slug text;
  v_shop text;
begin
  if new.status = 'published' and coalesce(new.stock_qty, 1) > 0
     and (old.status <> 'published' or coalesce(old.stock_qty, 1) = 0) then
    select slug, name into v_slug, v_shop from food.shops where id = new.shop_id;
    insert into food.notifications (user_id, title, body, link)
    select a.user_id, left(new.name || ' is back', 120), left('You can order it again from ' || v_shop || '.', 300), '/s/' || v_slug || '/i/' || new.id
      from food.stock_alerts a where a.product_id = new.id;
    delete from food.stock_alerts where product_id = new.id;
  end if;
  return new;
end $$;
create trigger products_back_in_stock after update of status, stock_qty on food.products
  for each row execute function food.notify_back_in_stock();
