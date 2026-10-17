-- Show the newer features on the demo shops: popular dishes (from past demo
-- orders), discount codes, shop notices, set days, sold-out dishes, and cooks
-- in more UK cities. Everything here goes when the demo shops are removed.

-- ---------- Past demo orders, so "Popular" shows ----------
alter table food.orders disable trigger orders_block_demo;
alter table food.orders disable trigger orders_notify;
alter table food.orders disable trigger orders_check_closure;
alter table food.orders disable trigger orders_daily_limit;

do $$
declare
  p record;
  v_n int;
  v_order uuid;
  v_when timestamptz;
  v_names text[] := array['Priya', 'Tom', 'Leah', 'Chris', 'Sam', 'Aisha', 'Dan', 'Mo', 'Ella', 'Kofi', 'Zara', 'Ben'];
begin
  for p in
    select pr.id, pr.shop_id, pr.name, pr.price_pence, pr.version,
           row_number() over (partition by pr.shop_id order by pr.created_at, pr.id) as rn
      from food.products pr join food.shops s on s.id = pr.shop_id
     where s.is_demo
  loop
    v_n := case p.rn when 1 then 18 + (abs(hashtext(p.id::text)) % 15) when 2 then 6 + (abs(hashtext(p.id::text)) % 6) else 0 end;
    for i in 1 .. v_n loop
      v_order := gen_random_uuid();
      v_when := now() - make_interval(days => 1 + (i * 7 + abs(hashtext(p.id::text))) % 80, hours => i % 9);
      insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence,
                               total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
      values (v_order, null, p.shop_id, 'completed', 'collection', v_names[1 + i % 12], p.price_pence, 0,
              p.price_pence, round(p.price_pence * 0.1), v_when, v_when, v_when, v_when + interval '2 hours');
      insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence)
      values (v_order, p.id, p.version, p.name, p.price_pence, 1, p.price_pence);
    end loop;
  end loop;
end $$;

alter table food.orders enable trigger orders_block_demo;
alter table food.orders enable trigger orders_notify;
alter table food.orders enable trigger orders_check_closure;
alter table food.orders enable trigger orders_daily_limit;

-- ---------- Discount codes shown on the shop page ----------
insert into food.shop_discounts (shop_id, code, kind, value, min_spend_pence, new_customers_only, show_on_shop) values
  ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'WELCOME10', 'percent', 10, 0, true, true),
  ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'SUNDAY3', 'amount', 300, 2000, false, true),
  ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'DUMPLING15', 'percent', 15, 1500, false, true),
  ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'SWEET5', 'amount', 500, 3000, false, true);

-- ---------- Shop notices ----------
update food.shops set notice = 'Jollof party trays for 10 are back. Order 2 days ahead.', notice_until = null
 where id = '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4';
update food.shops set notice = 'Fresh dumplings every Friday and Saturday. Frozen bags all week.', notice_until = null
 where id = '2d4f6211-a979-5d08-8005-29c68d5a4b6c';

-- ---------- Dishes made on set days, and daily limits ----------
update food.products set available_days = '{6}' where id = 'd99b2f80-19de-5628-b362-18356b0f714b';       -- Lamb nihari: Sundays
update food.products set available_days = '{4,5}' where id = '6aa86fc5-c9b5-5142-9397-9bffabeebc81';     -- Rum cake: Fri, Sat
update food.products set available_days = '{0,2,4}' where id = '3427a7f8-98c5-5f5a-8427-495638da36b7';   -- Meal prep: Mon, Wed, Fri
update food.shop_settings set max_orders_per_day = 15 where shop_id in (select id from food.shops where is_demo);

-- ---------- Sold out, so "Tell me when it's back" shows ----------
update food.products set stock_qty = 0 where id in ('7ebf50a2-4ca0-5210-8438-3895b8c0ad8a', '9bc1e504-1c25-52b2-8a26-23641ce2796b');

-- ---------- Cooks around the UK, not only London ----------
update food.shops set area_label = 'Sparkbrook, Birmingham' where id = 'c915ca7b-2fce-51bb-b49f-1b1957a46a84';
update food.shop_private set city = 'Birmingham', postcode = 'B11 1AA', lat = 52.462, lng = -1.869 where shop_id = 'c915ca7b-2fce-51bb-b49f-1b1957a46a84';
update food.shops set area_label = 'Ancoats, Manchester' where id = '2d4f6211-a979-5d08-8005-29c68d5a4b6c';
update food.shop_private set city = 'Manchester', postcode = 'M4 6AA', lat = 53.484, lng = -2.226 where shop_id = '2d4f6211-a979-5d08-8005-29c68d5a4b6c';
update food.shops set area_label = 'Stokes Croft, Bristol' where id = 'bf05b5c0-b192-557f-9476-5bffd7887880';
update food.shop_private set city = 'Bristol', postcode = 'BS1 3AA', lat = 51.463, lng = -2.590 where shop_id = 'bf05b5c0-b192-557f-9476-5bffd7887880';
update food.reviews set comment = replace(comment, 'the best I have had in London', 'the best I have had in ages')
 where shop_id in (select id from food.shops where is_demo);
