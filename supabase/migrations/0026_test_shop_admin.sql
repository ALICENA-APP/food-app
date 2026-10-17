-- The test shop setup as a function, so it can find "Meli" under a looser
-- match and an admin can turn any shop into a test shop from Admin > Shops.

create function food.fill_test_shop(p_shop uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_shop food.shops;
  v_owner uuid;
  p_curry uuid; p_samosa uuid; p_sponge uuid; p_prep uuid; p_brownie uuid;
  v_large uuid;
  v_order uuid;
  r record;
  i int := 0;
begin
  select * into v_shop from food.shops where id = p_shop;
  if not found then raise exception 'Shop not found'; end if;
  if v_shop.is_demo then raise exception 'Demo shops already have sample data'; end if;
  if v_shop.is_test then raise exception 'This shop is already a test shop'; end if;
  select user_id into v_owner from food.seller_accounts where id = v_shop.seller_account_id;

  -- Approved and able to take (pretend) payments, so the shop can be live.
  update food.seller_accounts
     set status = 'approved', approved_at = coalesce(approved_at, now()), charges_enabled = true
   where id = v_shop.seller_account_id;
  update food.shops
     set is_test = true, status = 'live', accepting_orders = true,
         story = coalesce(nullif(trim(story), ''), 'Home cooking made with love, fresh every day. This shop is being used to test BiteBY.'),
         logo_path = coalesce(logo_path, '/demo/hana-logo.svg'),
         cover_path = coalesce(cover_path, '/demo/nani-cover.svg'),
         cuisines = case when cardinality(cuisines) = 0 then array['Homemade'] else cuisines end,
         area_label = coalesce(area_label, 'Shoreditch, London')
   where id = v_shop.id;

  insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
  values (v_shop.id, 'Test address', 'London', 'E1 6AN', 'Ring the bell and wait by the door.', 51.523, -0.077)
  on conflict (shop_id) do update
    set lat = coalesce(food.shop_private.lat, excluded.lat), lng = coalesce(food.shop_private.lng, excluded.lng),
        postcode = coalesce(food.shop_private.postcode, excluded.postcode), city = coalesce(food.shop_private.city, excluded.city);

  insert into food.shop_settings (shop_id, offers_collection, offers_delivery, delivery_radius_miles, radius_fee_pence, takes_catering, max_orders_per_day)
  values (v_shop.id, true, true, 3, 250, true, 30)
  on conflict (shop_id) do update
    set offers_collection = true, offers_delivery = true,
        delivery_radius_miles = coalesce(food.shop_settings.delivery_radius_miles, 3),
        radius_fee_pence = case when food.shop_settings.radius_fee_pence = 0 then 250 else food.shop_settings.radius_fee_pence end,
        takes_catering = true, max_orders_per_day = greatest(coalesce(food.shop_settings.max_orders_per_day, 30), 30);

  if not exists (select 1 from food.shop_hours where shop_id = v_shop.id) then
    insert into food.shop_hours (shop_id, weekday, opens, closes)
    select v_shop.id, d, '07:00', '23:00' from generate_series(0, 6) d;
  end if;

  insert into food.shop_discounts (shop_id, code, kind, value, min_spend_pence, show_on_shop)
  values (v_shop.id, 'TESTME10', 'percent', 10, 1000, true) on conflict do nothing;

  if not exists (select 1 from food.seller_verifications where seller_account_id = v_shop.seller_account_id and kind = 'hygiene_rating' and status = 'accepted') then
    insert into food.seller_verifications (seller_account_id, kind, status, rating, rating_date, notes, reviewed_at)
    values (v_shop.seller_account_id, 'hygiene_rating', 'accepted', 5, current_date - 120, 'Sample rating for testing.', now());
  end if;

  -- Sample dishes: added as drafts, given all 14 allergens, then published.
  insert into food.products (shop_id, name, description, category_id, price_pence, portion, ingredients, dietary)
  values (v_shop.id, 'Chicken curry and rice', 'Slow-cooked chicken in a rich tomato and onion sauce with basmati rice. Sample dish.',
          (select id from food.categories where slug = 'meals'), 950, 'Serves 1', 'Sample dish for testing.', array['halal'])
  returning id into p_curry;
  insert into food.products (shop_id, name, description, category_id, price_pence, portion, ingredients, dietary, stock_qty)
  values (v_shop.id, 'Vegetable samosas', 'Crispy pastry filled with spiced potato and peas. Sample dish, currently sold out.',
          (select id from food.categories where slug = 'sides-snacks'), 450, 'Box of 6', 'Sample dish for testing.', array['vegetarian'], 0)
  returning id into p_samosa;
  insert into food.products (shop_id, name, description, category_id, price_pence, portion, ingredients, dietary, min_lead_hours)
  values (v_shop.id, 'Victoria sponge cake', 'Jam and buttercream sponge, made to order. Order 2 days ahead. Sample dish.',
          (select id from food.categories where slug = 'cakes-bakes'), 2200, 'Serves 10', 'Sample dish for testing.', array['vegetarian'], 48)
  returning id into p_sponge;
  insert into food.products (shop_id, name, description, category_id, price_pence, portion, ingredients, dietary, available_days)
  values (v_shop.id, 'Chickpea curry meal prep', 'Five chilled portions for the week. Made on Mondays and Thursdays only. Sample dish.',
          (select id from food.categories where slug = 'meal-prep'), 3000, '5 portions', 'Sample dish for testing.', array['vegan'], '{0,3}')
  returning id into p_prep;
  insert into food.products (shop_id, name, description, category_id, price_pence, portion, ingredients, dietary)
  values (v_shop.id, 'Chocolate brownies', 'Fudgy brownies with dark chocolate. May contain nuts. Sample dish.',
          (select id from food.categories where slug = 'desserts'), 500, '4 pieces', 'Sample dish for testing.', array['vegetarian'])
  returning id into p_brownie;

  insert into food.product_images (product_id, path, sort) values
    (p_curry, '/demo/nani-biryani.svg', 0), (p_samosa, '/demo/nani-samosa.svg', 0), (p_sponge, '/demo/hana-vic.svg', 0),
    (p_prep, '/demo/green-chickpea.svg', 0), (p_brownie, '/demo/hana-choc.svg', 0);

  insert into food.product_allergens (product_id, allergen_code, presence)
  select p, a.code,
         case when (p = p_curry and a.code in ('milk', 'celery', 'mustard'))
                or (p = p_samosa and a.code in ('cereals_gluten'))
                or (p = p_sponge and a.code in ('cereals_gluten', 'eggs', 'milk'))
                or (p = p_prep and a.code in ('celery'))
                or (p = p_brownie and a.code in ('cereals_gluten', 'eggs', 'milk', 'soya'))
              then 'contains'::food.allergen_presence
              when p = p_brownie and a.code in ('tree_nuts', 'peanuts') then 'may_contain'::food.allergen_presence
              else 'not_present'::food.allergen_presence end
    from unnest(array[p_curry, p_samosa, p_sponge, p_prep, p_brownie]) p cross join food.allergens a;

  insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values (p_curry, 'Size', 'Regular', 0, 0);
  insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values (p_curry, 'Size', 'Large', 300, 1) returning id into v_large;
  insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values
    (p_sponge, 'Size', '8 inch (serves 10)', 0, 0), (p_sponge, 'Size', '10 inch (serves 16)', 1000, 1);
  insert into food.product_addons (product_id, name, price_pence, sort) values
    (p_curry, 'Garlic naan', 150, 0), (p_curry, 'Extra rice', 100, 1), (p_curry, 'Mango chutney', 0, 2),
    (p_brownie, 'Scoop of ice cream', 150, 0);

  update food.products set status = 'published', allergens_confirmed_at = now()
   where id in (p_curry, p_samosa, p_sponge, p_prep, p_brownie);

  -- Sample orders from pretend customers, in every stage.
  alter table food.orders disable trigger orders_notify;
  alter table food.orders disable trigger orders_daily_limit;
  alter table food.orders disable trigger orders_check_closure;
  alter table food.order_items disable trigger order_items_available_day;
  alter table food.reviews disable trigger reviews_notify;

  for r in select * from (values
      -- name, status, fulfilment, days ago, dish, qty, rating, comment
      ('Priya Shah', 'completed', 'collection', 24, 'curry', 2, 5, 'Best curry I''ve had in ages. Will order again!'),
      ('Ben Carter', 'completed', 'delivery', 20, 'curry', 1, 5, 'Arrived hot and on time. Lovely.'),
      ('Priya Shah', 'completed', 'collection', 15, 'brownie', 2, 4, 'Really rich brownies, the kids loved them.'),
      ('Leah Moore', 'completed', 'collection', 12, 'sponge', 1, 5, 'Made my mum''s birthday. Beautiful cake.'),
      ('Ben Carter', 'completed', 'delivery', 8, 'curry', 2, 4, null),
      ('Chris Evans', 'completed', 'collection', 5, 'samosa', 1, 3, 'Tasty but a little cold by the time I got home.'),
      ('Priya Shah', 'completed', 'collection', 3, 'curry', 1, null, null),
      ('Tom Hughes', 'declined', 'delivery', 2, 'sponge', 1, null, null),
      ('Aisha Khan', 'ready', 'collection', 0, 'brownie', 1, null, null),
      ('Jordan Lee', 'accepted', 'collection', 0, 'curry', 3, null, null),
      ('Sam Patel', 'pending_acceptance', 'collection', 0, 'curry', 1, null, null),
      ('Leah Moore', 'pending_acceptance', 'delivery', 0, 'brownie', 2, null, null)
    ) as t(name, status, fulfilment, days, dish, qty, rating, comment)
  loop
    i := i + 1;
    declare
      v_product uuid := case r.dish when 'curry' then p_curry when 'samosa' then p_samosa when 'sponge' then p_sponge else p_brownie end;
      v_price int := case r.dish when 'curry' then 950 when 'samosa' then 450 when 'sponge' then 2200 else 500 end;
      v_dish text := case r.dish when 'curry' then 'Chicken curry and rice' when 'samosa' then 'Vegetable samosas' when 'sponge' then 'Victoria sponge cake' else 'Chocolate brownies' end;
      v_sub int := v_price * r.qty;
      v_fee int := case when r.fulfilment = 'delivery' then 250 else 0 end;
      v_at timestamptz := now() - make_interval(days => r.days, hours => case when r.days = 0 then 1 + i % 3 else 2 end);
    begin
      insert into food.orders (customer_id, shop_id, status, fulfilment, requested_for, customer_name, customer_note,
                               delivery_address, delivery_postcode, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence,
                               decline_reason, created_at, paid_at, accepted_at, completed_at)
      values (null, v_shop.id, r.status::food.order_status, r.fulfilment::food.fulfilment,
              case when r.status = 'accepted' then date_trunc('hour', now()) + interval '3 hours' end,
              r.name,
              case when i = 11 then 'Mild please, it''s for my little one.' when i = 10 then 'Can I collect a bit early?' end,
              case when r.fulfilment = 'delivery' then '12 Sample Street, London' end,
              case when r.fulfilment = 'delivery' then 'E1 6AN' end,
              v_sub, v_fee, v_sub + v_fee, round(v_sub * 0.10),
              case when r.status = 'declined' then 'Sorry, I''m fully booked for cakes that day.' end,
              v_at, v_at,
              case when r.status in ('accepted', 'ready', 'completed') then v_at + interval '10 minutes' end,
              case when r.status = 'completed' then v_at + interval '1 hour' end)
      returning id into v_order;
      insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence, contains, may_contain, variant_id)
      select v_order, v_product, p.version, v_dish || case when r.dish = 'curry' and r.qty = 3 then ' (Large)' else '' end,
             v_price, r.qty, v_sub,
             coalesce((select array_agg(allergen_code order by allergen_code) from food.product_allergens where product_id = v_product and presence = 'contains' and variant_id is null and addon_id is null), '{}'),
             coalesce((select array_agg(allergen_code order by allergen_code) from food.product_allergens where product_id = v_product and presence = 'may_contain' and variant_id is null and addon_id is null), '{}'),
             case when r.dish = 'curry' and r.qty = 3 then v_large end
        from food.products p where p.id = v_product;
      if r.rating is not null then
        insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, loved_products, photo_path, seller_reply, seller_replied_at, created_at)
        values (v_order, v_shop.id, null, split_part(r.name, ' ', 1), r.rating, r.comment,
                case when r.rating >= 4 then array[v_product] else '{}' end,
                case when r.rating = 5 then (select path from food.product_images where product_id = v_product limit 1) end,
                case when i = 1 then 'Thank you Priya, see you soon!' end, case when i = 1 then now() - interval '20 days' end,
                v_at + interval '1 day');
      end if;
      if r.status = 'pending_acceptance' then
        insert into food.notifications (user_id, title, body, link)
        select v_owner, 'New order ' || o.code, o.customer_name || ' · ' || o.fulfilment || ' · £' || to_char(o.total_pence / 100.0, 'FM999990.00'), '/sell/orders'
          from food.orders o where o.id = v_order;
      end if;
    end;
  end loop;

  alter table food.orders enable trigger orders_notify;
  alter table food.orders enable trigger orders_daily_limit;
  alter table food.orders enable trigger orders_check_closure;
  alter table food.order_items enable trigger order_items_available_day;
  alter table food.reviews enable trigger reviews_notify;
end $$;
revoke execute on function food.fill_test_shop(uuid) from public, anon, authenticated;

create function food.admin_make_test_shop(p_shop uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if exists (select 1 from food.shops where is_test and id <> p_shop) then
    raise exception 'There is already a test shop. Remove demo data first to clear it.';
  end if;
  perform food.fill_test_shop(p_shop);
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id)
  values (auth.uid(), 'admin', 'test_shop_made', 'shops', p_shop::text);
end $$;
revoke execute on function food.admin_make_test_shop(uuid) from public, anon;
grant execute on function food.admin_make_test_shop(uuid) to authenticated;

do $$
declare
  v_shop uuid;
begin
  if exists (select 1 from food.shops where is_test) then return; end if;
  select id into v_shop from food.shops
   where not is_demo and (name ilike '%meli%' or slug ilike '%meli%')
   order by (lower(name) = 'meli') desc, created_at limit 1;
  if v_shop is null then
    raise notice 'Still no shop called Meli (% real shops so far)', (select count(*) from food.shops where not is_demo);
    return;
  end if;
  perform food.fill_test_shop(v_shop);
  raise notice 'Test shop set up';
end $$;
