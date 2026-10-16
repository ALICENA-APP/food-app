-- Sponsored (featured) shops, demo shops to explore the app, and keeping
-- orders and payments on BiteBY.

-- ---------------------------------------------------------------------------
-- Keeping orders and payments on BiteBY
-- ---------------------------------------------------------------------------
-- Why a piece of text would take an order or payment off BiteBY, or null.
create function food.off_app_reason(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  t text := lower(coalesce(p, ''));
  digits text := regexp_replace(t, '[\s().-]', '', 'g');
begin
  if t ~ '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+' then return 'an email address'; end if;
  if t ~ '(https?://|www\.|\.co\.uk\M|\.com\M|wa\.me|bit\.ly)' then return 'a website link'; end if;
  if digits ~ '(\+44|0044|07)\d{9}' or digits ~ '(^|\D)0[1-9]\d{8,9}($|\D)' then return 'a phone number'; end if;
  if t ~ '\m\d{2}-\d{2}-\d{2}\M' or t ~ '\m(sort ?code|account (no|number)|acc no|iban)\M' then return 'bank details'; end if;
  if t ~ '\m(cash|paypal|revolut|monzo|cash ?app|venmo|bank transfer|pay (me )?direct(ly)?|pay (me )?outside|off the app|outside (of )?(the )?app|whatsapp|telegram|snapchat)\M' then
    return 'payment or contact outside BiteBY';
  end if;
  return null;
end $$;
grant execute on function food.off_app_reason(text) to anon, authenticated;

-- Hides email addresses, links and phone or bank numbers in a message.
create function food.redact_contact(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(p,
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+', '[hidden]', 'g'),
    '(https?://|www\.)\S+', '[hidden]', 'gi'),
    '(\+?\d[\d\s().-]{8,}\d)', '[hidden]', 'g'),
    '\m\d{2}-\d{2}-\d{2}\M', '[hidden]', 'g')
$$;

-- Attempts the team should know about. Only admins can read them.
create table food.safety_flags (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete set null,
  shop_id uuid references food.shops (id) on delete cascade,
  order_id uuid references food.orders (id) on delete set null,
  source text not null check (char_length(source) <= 40),
  reason text not null check (char_length(reason) <= 80),
  excerpt text check (char_length(excerpt) <= 300),
  created_at timestamptz not null default now()
);
create index on food.safety_flags (created_at desc);
alter table food.safety_flags enable row level security;
grant select on food.safety_flags to authenticated;
create policy "safety flags: admins" on food.safety_flags for select to authenticated using (food.is_admin());

-- Shop pages and dishes can't carry phone numbers, links or "pay me direct".
create function food.check_public_text() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_reason text;
begin
  if tg_table_name = 'shops' then
    v_reason := coalesce(food.off_app_reason(new.name), food.off_app_reason(new.story), food.off_app_reason(new.notice), food.off_app_reason(new.area_label));
  else
    v_reason := coalesce(food.off_app_reason(new.name), food.off_app_reason(new.description), food.off_app_reason(new.portion));
  end if;
  if v_reason is not null then
    raise exception 'Please take out % from your text. Customers order and pay through BiteBY, which keeps you and them protected.', v_reason;
  end if;
  return new;
end $$;
create trigger shops_public_text before insert or update of name, story, notice, area_label on food.shops
  for each row execute function food.check_public_text();
create trigger products_public_text before insert or update of name, description, portion on food.products
  for each row execute function food.check_public_text();

drop function food.send_order_message(uuid, text);
create function food.send_order_message(p_order uuid, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o food.orders;
  v_seller boolean;
  v_shop text;
  v_body text := btrim(p_body);
  v_reason text;
  v_note text;
begin
  select * into o from food.orders where id = p_order;
  if not found then raise exception 'Order not found'; end if;
  v_seller := food.owns_shop(o.shop_id);
  if not v_seller and o.customer_id is distinct from auth.uid() then
    raise exception 'Not your order';
  end if;
  if o.status = 'awaiting_payment' then
    raise exception 'You can message the cook once the order has been paid';
  end if;
  if o.status in ('completed', 'declined', 'cancelled', 'expired', 'refunded')
     and o.updated_at < now() - interval '7 days' then
    raise exception 'This order has closed, so messages are switched off';
  end if;
  if char_length(v_body) = 0 then raise exception 'Write a message first'; end if;
  if (select count(*) from food.order_messages where order_id = p_order and sender_id = auth.uid()
        and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many messages. Please wait a little.';
  end if;
  -- Contact details and payment outside BiteBY are taken out and flagged.
  v_reason := food.off_app_reason(v_body);
  if v_reason is not null then
    insert into food.safety_flags (user_id, shop_id, order_id, source, reason, excerpt)
    values (auth.uid(), o.shop_id, p_order, case when v_seller then 'seller message' else 'customer message' end, v_reason, left(v_body, 300));
    v_body := food.redact_contact(v_body);
    v_note := 'For everyone''s safety, contact details and payment outside BiteBY aren''t allowed in messages, so part of your message was hidden. Orders paid outside BiteBY aren''t protected.';
  end if;
  insert into food.order_messages (order_id, sender_id, from_seller, body)
  values (p_order, auth.uid(), v_seller, left(v_body, 1000));

  select name into v_shop from food.shops where id = o.shop_id;
  if v_seller then
    insert into food.notifications (user_id, title, body, link)
    values (o.customer_id, 'Message from ' || v_shop, left(v_body, 300), '/orders/' || o.id);
  else
    insert into food.notifications (user_id, title, body, link)
    values (food.shop_owner(o.shop_id), 'Message from ' || o.customer_name || ' · ' || o.code, left(v_body, 300), '/sell/orders?open=' || o.id);
  end if;
  return v_note;
end $$;

revoke execute on function food.send_order_message(uuid, text) from public, anon;
grant execute on function food.send_order_message(uuid, text) to authenticated;

create function food.admin_safety_flags() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select f.id, f.source, f.reason, f.excerpt, f.created_at, s.name as shop_name, s.slug, o.code as order_code, u.email,
             (select count(*) from food.safety_flags f2 where f2.shop_id = f.shop_id) as shop_total
        from food.safety_flags f
        left join food.shops s on s.id = f.shop_id
        left join food.orders o on o.id = f.order_id
        left join auth.users u on u.id = f.user_id
       order by f.created_at desc
       limit 200
    ) x), '[]'::jsonb);
end $$;
revoke execute on function food.admin_safety_flags() from public, anon;
grant execute on function food.admin_safety_flags() to authenticated;

-- ---------------------------------------------------------------------------
-- Sponsored shops ("Featured cooks")
-- ---------------------------------------------------------------------------
alter table food.platform_settings
  add column promo_week_pence integer not null default 500 check (promo_week_pence between 0 and 100000),
  add column promo_slots integer not null default 8 check (promo_slots between 0 and 50);

create table food.promotions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  weeks smallint not null check (weeks between 1 and 8),
  status text not null default 'requested' check (status in ('requested', 'active', 'declined', 'cancelled')),
  starts_on date,
  ends_on date,
  fee_pence integer not null default 0 check (fee_pence >= 0),
  note text check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users (id)
);
create index on food.promotions (status, ends_on);
alter table food.promotions enable row level security;
grant select on food.promotions to authenticated;
create policy "promotions: owner or admin" on food.promotions
  for select to authenticated using (food.owns_shop(shop_id) or food.is_admin());

-- Shops featured today, in an order that changes daily so everyone gets a turn at the front.
create function food.featured_shops() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.shop_id from food.promotions p
   where p.status = 'active' and current_date between p.starts_on and p.ends_on
     and food.shop_is_public(p.shop_id)
   group by p.shop_id
   order by md5(p.shop_id::text || current_date::text)
   limit 12
$$;
grant execute on function food.featured_shops() to anon, authenticated;

create function food.request_promotion(p_weeks int) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_shop uuid;
  v_id uuid;
  v_week int;
begin
  select s.id into v_shop from food.shops s join food.seller_accounts a on a.id = s.seller_account_id
   where a.user_id = auth.uid() limit 1;
  if v_shop is null then raise exception 'Set up your shop first'; end if;
  if p_weeks not between 1 and 8 then raise exception 'Choose between 1 and 8 weeks'; end if;
  if exists (select 1 from food.promotions where shop_id = v_shop and (status = 'requested' or (status = 'active' and ends_on >= current_date))) then
    raise exception 'You already have a featured spot or a request waiting';
  end if;
  select promo_week_pence into v_week from food.platform_settings where id = 1;
  insert into food.promotions (shop_id, weeks, fee_pence) values (v_shop, p_weeks, p_weeks * coalesce(v_week, 500))
  returning id into v_id;
  insert into food.notifications (user_id, title, body, link)
  select a.user_id, 'Featured spot request', (select name from food.shops where id = v_shop) || ' · ' || p_weeks || ' week(s)', '/admin?tab=promoted'
    from food.app_admins a where a.revoked_at is null;
  return v_id;
end $$;
revoke execute on function food.request_promotion(int) from public, anon;
grant execute on function food.request_promotion(int) to authenticated;

create function food.admin_promotions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  return jsonb_build_object(
    'slots', (select promo_slots from food.platform_settings where id = 1),
    'week_pence', (select promo_week_pence from food.platform_settings where id = 1),
    'list', coalesce((
      select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
        select p.*, s.name as shop_name, s.slug, s.is_demo,
               (p.status = 'active' and current_date between p.starts_on and p.ends_on) as running
          from food.promotions p join food.shops s on s.id = p.shop_id
         where p.status in ('requested', 'active') or p.created_at > now() - interval '60 days'
         order by p.created_at desc limit 100
      ) x), '[]'::jsonb));
end $$;
revoke execute on function food.admin_promotions() from public, anon;
grant execute on function food.admin_promotions() to authenticated;

-- Approve (starts today), decline, or end early.
create function food.admin_decide_promotion(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p food.promotions;
  v_owner uuid;
  v_shop text;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  select * into p from food.promotions where id = p_id for update;
  if not found then raise exception 'Not found'; end if;
  if p_action = 'approve' then
    if p.status <> 'requested' then raise exception 'Only requests can be approved'; end if;
    if (select count(distinct shop_id) from food.promotions where status = 'active' and current_date between starts_on and ends_on)
       >= (select promo_slots from food.platform_settings where id = 1) then
      raise exception 'All featured spots are taken. End one first or add more spots.';
    end if;
    update food.promotions set status = 'active', starts_on = current_date, ends_on = current_date + weeks * 7 - 1,
           note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
  elsif p_action = 'decline' then
    update food.promotions set status = 'declined', note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
  elsif p_action = 'end' then
    update food.promotions set status = 'cancelled', ends_on = least(ends_on, current_date - 1), note = coalesce(p_note, note), decided_at = now(), decided_by = auth.uid() where id = p_id;
  else
    raise exception 'Unknown action';
  end if;
  select food.shop_owner(p.shop_id), name into v_owner, v_shop from food.shops where id = p.shop_id;
  if v_owner is not null and p_action <> 'end' then
    insert into food.notifications (user_id, title, body, link)
    values (v_owner, case when p_action = 'approve' then 'You''re featured on BiteBY' else 'Featured spot request' end,
            case when p_action = 'approve' then v_shop || ' is now in Featured cooks for ' || p.weeks || ' week(s).'
                 else coalesce(p_note, 'Your request wasn''t approved this time.') end, '/sell');
  end if;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason)
  values (auth.uid(), 'admin', 'promotion_' || p_action, 'promotions', p_id::text, p_note);
end $$;
revoke execute on function food.admin_decide_promotion(uuid, text, text) from public, anon;
grant execute on function food.admin_decide_promotion(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Demo shops
-- ---------------------------------------------------------------------------
alter table food.seller_accounts alter column user_id drop not null;
alter table food.seller_accounts add column is_demo boolean not null default false;
alter table food.seller_accounts add constraint seller_accounts_real_have_user check (user_id is not null or is_demo);
alter table food.shops add column is_demo boolean not null default false;

-- Followers of a demo cook can still get new-dish alerts (the owner check copes with no owner).
create or replace function food.announce_new_dish() returns trigger
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
     and f.user_id is distinct from (select sa.user_id from food.seller_accounts sa where sa.id = v_shop.seller_account_id);
  return null;
end $$;

alter table food.orders disable trigger orders_notify;
alter table food.reviews disable trigger reviews_notify;

-- Demo data, generated by gen_demo.py. Everything here is marked is_demo and
-- can be removed in one go from Admin > Overview.
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('1f046189-1120-5547-b599-15bc4444a03c', null, 'approved', 'Ama''s Kitchen (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', '1f046189-1120-5547-b599-15bc4444a03c', 'demo-amas-kitchen', 'Ama''s Kitchen', 'I learned to cook from my mum in Lagos. Every pot of jollof is smoky, slow-cooked and made fresh on the day.', '/demo/ama-logo.svg', '/demo/ama-cover.svg', array['Nigerian', 'West African'], 'Bow, E3', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'Demo address (not real)', 'London', 'E3 2AA', 'This is a demo shop.', 51.529, -0.021);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence, delivery_radius_miles, radius_fee_pence, radius_min_order_pence)
values ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', true, true, 0, 3, 300, 1200);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 0, '11:00', '20:00'), ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 1, '11:00', '20:00'), ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 2, '11:00', '20:00'), ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 3, '11:00', '20:00'), ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 4, '11:00', '20:00'), ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 5, '11:00', '20:00');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'Jollof rice and chicken', 'Smoky party jollof with spiced grilled chicken thigh.', (select id from food.categories where slug = 'meals'), 950, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', '/demo/ama-jollof.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '76a5a5c8-1eb9-5df4-a01f-09c5c422503d', code, case when code in ('celery') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 'Size', 'Regular', 0, 0);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 'Size', 'Large', 300, 1);
insert into food.product_addons (product_id, name, price_pence, sort) values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 'Fried plantain', 200, 0);
insert into food.product_addons (product_id, name, price_pence, sort) values ('76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 'Moi moi', 250, 1);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('a60bf3e8-e71e-5e0d-80f7-42256ef00ab9', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'Egusi soup and pounded yam', 'Rich melon seed soup with spinach and assorted meat.', (select id from food.categories where slug = 'meals'), 1100, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('a60bf3e8-e71e-5e0d-80f7-42256ef00ab9', '/demo/ama-egusi.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'a60bf3e8-e71e-5e0d-80f7-42256ef00ab9', code, case when code in ('fish', 'crustaceans') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('83cdf0a1-f3f2-57bf-81af-14a3f4b34267', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'Puff puff', 'Soft, sweet fried dough balls. Dangerous in a good way.', (select id from food.categories where slug = 'desserts'), 400, 'Box of 6', 'Demo dish: see the description.', true, true, 12, 0, array['vegetarian']::text[]);
insert into food.product_images (product_id, path, sort) values ('83cdf0a1-f3f2-57bf-81af-14a3f4b34267', '/demo/ama-puff.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '83cdf0a1-f3f2-57bf-81af-14a3f4b34267', code, case when code in ('cereals_gluten') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('83cdf0a1-f3f2-57bf-81af-14a3f4b34267', 'Box', 'Box of 6', 0, 0);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('83cdf0a1-f3f2-57bf-81af-14a3f4b34267', 'Box', 'Box of 12', 350, 1);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('517b975c-2757-5505-8125-35c67ec3568e', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'Beef suya skewers', 'Thin-sliced beef with yaji spice, onions and tomato.', (select id from food.categories where slug = 'sides-snacks'), 800, '3 skewers', 'Demo dish: see the description.', true, true, null, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('517b975c-2757-5505-8125-35c67ec3568e', '/demo/ama-suya.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '517b975c-2757-5505-8125-35c67ec3568e', code, case when code in ('peanuts') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('3ca76176-8fe9-53c2-b058-970a8f3bf10c', null, '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'completed', 'collection', 'Demo customer', 950, 0, 950, 95, now() - interval '11 days', now() - interval '11 days', now() - interval '11 days', now() - interval '11 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('3ca76176-8fe9-53c2-b058-970a8f3bf10c', '76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 1, 'Jollof rice and chicken', 950, 1, 950);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('3ca76176-8fe9-53c2-b058-970a8f3bf10c', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', null, 'Priya', 5, 'Ordered for a family dinner and everyone loved it.', 'Thank you so much! See you next time.', now(), now() - interval '10 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('50520084-941f-5806-87a7-613da3b14066', null, '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'completed', 'collection', 'Demo customer', 1100, 0, 1100, 110, now() - interval '25 days', now() - interval '25 days', now() - interval '25 days', now() - interval '25 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('50520084-941f-5806-87a7-613da3b14066', 'a60bf3e8-e71e-5e0d-80f7-42256ef00ab9', 1, 'Egusi soup and pounded yam', 1100, 1, 1100);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('50520084-941f-5806-87a7-613da3b14066', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', null, 'Tom', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '24 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('b85a5acd-3511-51d5-b78e-d18af7f5dc40', null, '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'completed', 'collection', 'Demo customer', 400, 0, 400, 40, now() - interval '29 days', now() - interval '29 days', now() - interval '29 days', now() - interval '29 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('b85a5acd-3511-51d5-b78e-d18af7f5dc40', '83cdf0a1-f3f2-57bf-81af-14a3f4b34267', 1, 'Puff puff', 400, 1, 400);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('b85a5acd-3511-51d5-b78e-d18af7f5dc40', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', null, 'Leah', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '28 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('a0330671-e373-5c33-8991-10353472d623', null, '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'completed', 'collection', 'Demo customer', 800, 0, 800, 80, now() - interval '29 days', now() - interval '29 days', now() - interval '29 days', now() - interval '29 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('a0330671-e373-5c33-8991-10353472d623', '517b975c-2757-5505-8125-35c67ec3568e', 1, 'Beef suya skewers', 800, 1, 800);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('a0330671-e373-5c33-8991-10353472d623', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', null, 'Jess', 4, 'Lovely food, collection was easy.', 'Thanks for the kind words, I will tell my mum!', now(), now() - interval '28 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('d8a32d4e-cf2c-529c-a35e-69e1d96fafc4', null, '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 'completed', 'collection', 'Demo customer', 950, 0, 950, 95, now() - interval '39 days', now() - interval '39 days', now() - interval '39 days', now() - interval '39 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('d8a32d4e-cf2c-529c-a35e-69e1d96fafc4', '76a5a5c8-1eb9-5df4-a01f-09c5c422503d', 1, 'Jollof rice and chicken', 950, 1, 950);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('d8a32d4e-cf2c-529c-a35e-69e1d96fafc4', '960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', null, 'Chris', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '38 days');
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('a78f6147-1acb-50a9-ad80-aea4ead45630', null, 'approved', 'Rosa''s Caribbean Pot (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'a78f6147-1acb-50a9-ad80-aea4ead45630', 'demo-rosas-caribbean', 'Rosa''s Caribbean Pot', 'Sunday dinners at my nan''s house in Kingston, now cooked in Stratford. Jerk marinated overnight, always.', '/demo/rosa-logo.svg', '/demo/rosa-cover.svg', array['Jamaican', 'Caribbean'], 'Stratford, E15', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'Demo address (not real)', 'London', 'E15 1AA', 'This is a demo shop.', 51.543, 0.002);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence, delivery_radius_miles, radius_fee_pence, radius_min_order_pence)
values ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', true, true, 1000, 2.5, 350, 1500);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 2, '12:00', '21:00'), ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 3, '12:00', '21:00'), ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 4, '12:00', '21:00'), ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 5, '12:00', '21:00'), ('0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 6, '12:00', '21:00');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('2a97077c-d1cb-5e5d-a102-857faa3a5e51', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'Jerk chicken, rice and peas', 'Marinated overnight and grilled. Served with rice and peas.', (select id from food.categories where slug = 'meals'), 1000, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('2a97077c-d1cb-5e5d-a102-857faa3a5e51', '/demo/rosa-jerk.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '2a97077c-d1cb-5e5d-a102-857faa3a5e51', code, case when code in ('mustard', 'celery') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_addons (product_id, name, price_pence, sort) values ('2a97077c-d1cb-5e5d-a102-857faa3a5e51', 'Coleslaw', 150, 0);
insert into food.product_addons (product_id, name, price_pence, sort) values ('2a97077c-d1cb-5e5d-a102-857faa3a5e51', 'Festival dumplings', 250, 1);
insert into food.product_addons (product_id, name, price_pence, sort) values ('2a97077c-d1cb-5e5d-a102-857faa3a5e51', 'Extra gravy', 0, 2);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('e915fa64-d3b0-5bfd-9646-21da7661aa5f', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'Curry goat', 'Slow-cooked bone-in goat in Jamaican curry, with white rice.', (select id from food.categories where slug = 'meals'), 1200, 'Serves 1', 'Demo dish: see the description.', true, true, null, 24, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('e915fa64-d3b0-5bfd-9646-21da7661aa5f', '/demo/rosa-goat.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'e915fa64-d3b0-5bfd-9646-21da7661aa5f', code, case when code in ('celery') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('ee84d192-79cc-5f32-8d34-35d272fb039a', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'Ackee and saltfish', 'The national dish, with fried dumplings.', (select id from food.categories where slug = 'breakfast'), 1050, 'Serves 1', 'Demo dish: see the description.', true, true, 0, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('ee84d192-79cc-5f32-8d34-35d272fb039a', '/demo/rosa-ackee.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'ee84d192-79cc-5f32-8d34-35d272fb039a', code, case when code in ('fish', 'cereals_gluten') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('6aa86fc5-c9b5-5142-9397-9bffabeebc81', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'Rum and raisin cake slice', 'Moist fruit cake soaked in dark rum.', (select id from food.categories where slug = 'cakes-bakes'), 400, '1 slice', 'Demo dish: see the description.', true, true, null, 0, array['vegetarian']::text[]);
insert into food.product_images (product_id, path, sort) values ('6aa86fc5-c9b5-5142-9397-9bffabeebc81', '/demo/rosa-rumcake.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '6aa86fc5-c9b5-5142-9397-9bffabeebc81', code, case when code in ('cereals_gluten', 'eggs', 'milk', 'sulphites') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('2555a1ee-b618-5bc0-b4c7-e562775258e1', null, '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'completed', 'collection', 'Demo customer', 1000, 0, 1000, 100, now() - interval '4 days', now() - interval '4 days', now() - interval '4 days', now() - interval '4 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('2555a1ee-b618-5bc0-b4c7-e562775258e1', '2a97077c-d1cb-5e5d-a102-857faa3a5e51', 1, 'Jerk chicken, rice and peas', 1000, 1, 1000);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('2555a1ee-b618-5bc0-b4c7-e562775258e1', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', null, 'Kwame', 5, 'Tastes like home. Thank you!', null, null, now() - interval '3 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('da2b62a4-0492-5bf6-9497-c7053e866f1a', null, '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'completed', 'collection', 'Demo customer', 1200, 0, 1200, 120, now() - interval '11 days', now() - interval '11 days', now() - interval '11 days', now() - interval '11 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('da2b62a4-0492-5bf6-9497-c7053e866f1a', 'e915fa64-d3b0-5bfd-9646-21da7661aa5f', 1, 'Curry goat', 1200, 1, 1200);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('da2b62a4-0492-5bf6-9497-c7053e866f1a', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', null, 'Grace', 4, 'Lovely food, collection was easy.', null, null, now() - interval '10 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('8712897e-6e57-556d-b4ee-1b48b9ba59b2', null, '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'completed', 'collection', 'Demo customer', 1050, 0, 1050, 105, now() - interval '39 days', now() - interval '39 days', now() - interval '39 days', now() - interval '39 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('8712897e-6e57-556d-b4ee-1b48b9ba59b2', 'ee84d192-79cc-5f32-8d34-35d272fb039a', 1, 'Ackee and saltfish', 1050, 1, 1050);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('8712897e-6e57-556d-b4ee-1b48b9ba59b2', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', null, 'Tom', 5, 'Tastes like home. Thank you!', null, null, now() - interval '38 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('3bb66ff4-d606-56f8-b18d-a15e083209c7', null, '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', 'completed', 'collection', 'Demo customer', 400, 0, 400, 40, now() - interval '37 days', now() - interval '37 days', now() - interval '37 days', now() - interval '37 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('3bb66ff4-d606-56f8-b18d-a15e083209c7', '6aa86fc5-c9b5-5142-9397-9bffabeebc81', 1, 'Rum and raisin cake slice', 400, 1, 400);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('3bb66ff4-d606-56f8-b18d-a15e083209c7', '0c454c2f-dcbd-54e9-9fb6-54b7175453b5', null, 'Sam', 5, 'Ordered for a family dinner and everyone loved it.', null, null, now() - interval '36 days');
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('5d94a19a-168f-536e-8502-6239fdb84967', null, 'approved', 'Nani''s Kitchen (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', '5d94a19a-168f-536e-8502-6239fdb84967', 'demo-nanis-kitchen', 'Nani''s Kitchen', 'Family recipes from Lahore. Everything is halal and cooked the slow way, just like Nani taught us.', '/demo/nani-logo.svg', '/demo/nani-cover.svg', array['Pakistani', 'Halal'], 'Whitechapel, E1', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'Demo address (not real)', 'London', 'E1 1AA', 'This is a demo shop.', 51.519, -0.06);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence, delivery_radius_miles, radius_fee_pence, radius_min_order_pence)
values ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', true, true, 0, 2, 250, 1000);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 0, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 1, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 2, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 3, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 4, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 5, '12:00', '22:00'), ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 6, '12:00', '22:00');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'Chicken biryani', 'Layered basmati, tender chicken and fried onions. Halal.', (select id from food.categories where slug = 'meals'), 900, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array['halal']::text[]);
insert into food.product_images (product_id, path, sort) values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', '/demo/nani-biryani.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'd6b088c5-e319-5807-a5c3-1385c4d8cb7d', code, case when code in ('milk') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', 'Size', 'Regular', 0, 0);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', 'Size', 'Family (serves 4)', 2100, 1);
insert into food.product_addons (product_id, name, price_pence, sort) values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', 'Raita', 100, 0);
insert into food.product_addons (product_id, name, price_pence, sort) values ('d6b088c5-e319-5807-a5c3-1385c4d8cb7d', 'Extra chicken', 300, 1);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('d99b2f80-19de-5628-b362-18356b0f714b', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'Lamb nihari', 'Slow-cooked overnight. Served with naan. Halal.', (select id from food.categories where slug = 'meals'), 1150, 'Serves 1', 'Demo dish: see the description.', true, true, null, 12, array['halal']::text[]);
insert into food.product_images (product_id, path, sort) values ('d99b2f80-19de-5628-b362-18356b0f714b', '/demo/nani-nihari.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'd99b2f80-19de-5628-b362-18356b0f714b', code, case when code in ('cereals_gluten', 'milk') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('351c1c4c-4c00-55c0-9e84-33b2a098b3ae', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'Vegetable samosas', 'Crispy pastry, spiced potato and peas.', (select id from food.categories where slug = 'sides-snacks'), 450, '4 pieces', 'Demo dish: see the description.', true, true, null, 0, array['vegan', 'halal']::text[]);
insert into food.product_images (product_id, path, sort) values ('351c1c4c-4c00-55c0-9e84-33b2a098b3ae', '/demo/nani-samosa.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '351c1c4c-4c00-55c0-9e84-33b2a098b3ae', code, case when code in ('cereals_gluten') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('35b35d77-bd15-5aec-a7ab-20b5541e5112', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'Gulab jamun', 'Warm milk dumplings in rose and cardamom syrup.', (select id from food.categories where slug = 'desserts'), 400, '4 pieces', 'Demo dish: see the description.', true, true, null, 0, array['vegetarian', 'halal']::text[]);
insert into food.product_images (product_id, path, sort) values ('35b35d77-bd15-5aec-a7ab-20b5541e5112', '/demo/nani-gulab.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '35b35d77-bd15-5aec-a7ab-20b5541e5112', code, case when code in ('milk', 'cereals_gluten', 'tree_nuts') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('69430d99-7a91-51c2-8e1d-5367008edabf', null, 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'completed', 'collection', 'Demo customer', 900, 0, 900, 90, now() - interval '33 days', now() - interval '33 days', now() - interval '33 days', now() - interval '33 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('69430d99-7a91-51c2-8e1d-5367008edabf', 'd6b088c5-e319-5807-a5c3-1385c4d8cb7d', 1, 'Chicken biryani', 900, 1, 900);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('69430d99-7a91-51c2-8e1d-5367008edabf', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', null, 'Zara', 5, 'Tastes like home. Thank you!', null, null, now() - interval '32 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('aa62c01c-0923-5c33-977f-554125cf6760', null, 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'completed', 'collection', 'Demo customer', 1150, 0, 1150, 115, now() - interval '39 days', now() - interval '39 days', now() - interval '39 days', now() - interval '39 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('aa62c01c-0923-5c33-977f-554125cf6760', 'd99b2f80-19de-5628-b362-18356b0f714b', 1, 'Lamb nihari', 1150, 1, 1150);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('aa62c01c-0923-5c33-977f-554125cf6760', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', null, 'Mira', 4, 'Great value for the size.', null, null, now() - interval '38 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('ecf9e71d-7037-53ab-abdb-789c3d4f258d', null, 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'completed', 'collection', 'Demo customer', 450, 0, 450, 45, now() - interval '13 days', now() - interval '13 days', now() - interval '13 days', now() - interval '13 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('ecf9e71d-7037-53ab-abdb-789c3d4f258d', '351c1c4c-4c00-55c0-9e84-33b2a098b3ae', 1, 'Vegetable samosas', 450, 1, 450);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('ecf9e71d-7037-53ab-abdb-789c3d4f258d', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', null, 'Leah', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '12 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('9d8ea605-ea96-554d-96ed-810724b4bf9e', null, 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', 'completed', 'collection', 'Demo customer', 400, 0, 400, 40, now() - interval '21 days', now() - interval '21 days', now() - interval '21 days', now() - interval '21 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('9d8ea605-ea96-554d-96ed-810724b4bf9e', '35b35d77-bd15-5aec-a7ab-20b5541e5112', 1, 'Gulab jamun', 400, 1, 400);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('9d8ea605-ea96-554d-96ed-810724b4bf9e', 'c915ca7b-2fce-51bb-b49f-1b1957a46a84', null, 'Dan', 4, 'Very good, would like a bigger portion of the sides.', null, null, now() - interval '20 days');
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('73895544-4931-51c5-919d-d5cae67148c2', null, 'approved', 'Mei''s Dumplings (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', '73895544-4931-51c5-919d-d5cae67148c2', 'demo-meis-dumplings', 'Mei''s Dumplings', 'Hand-folded dumplings, a few hundred every week. Freeze some for later, they cook from frozen in 8 minutes.', '/demo/mei-logo.svg', '/demo/mei-cover.svg', array['Chinese', 'Dumplings'], 'Mile End, E3', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'Demo address (not real)', 'London', 'E3 4AA', 'This is a demo shop.', 51.525, -0.033);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence) values ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', true, false, 0);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 1, '11:30', '19:30'), ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 2, '11:30', '19:30'), ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 3, '11:30', '19:30'), ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 4, '11:30', '19:30'), ('2d4f6211-a979-5d08-8005-29c68d5a4b6c', 5, '11:30', '19:30');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('d13234ea-d763-5cfb-8486-d41c7587c682', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'Pork and chive dumplings', 'Juicy, hand-folded. Pan-fry or boil. Comes with chilli oil.', (select id from food.categories where slug = 'meals'), 850, '12 dumplings', 'Demo dish: see the description.', true, false, null, 0, array[]::text[]);
insert into food.product_images (product_id, path, sort) values ('d13234ea-d763-5cfb-8486-d41c7587c682', '/demo/mei-pork.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'd13234ea-d763-5cfb-8486-d41c7587c682', code, case when code in ('cereals_gluten', 'soya', 'sesame') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('d13234ea-d763-5cfb-8486-d41c7587c682', 'Cooked or frozen', 'Cooked', 0, 0);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('d13234ea-d763-5cfb-8486-d41c7587c682', 'Cooked or frozen', 'Frozen (cook at home)', -50, 1);
insert into food.product_addons (product_id, name, price_pence, sort) values ('d13234ea-d763-5cfb-8486-d41c7587c682', 'Extra chilli oil', 100, 0);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('bc7dcac7-d797-5743-8ad6-d5e916de733b', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'Vegetable dumplings', 'Cabbage, mushroom and glass noodles.', (select id from food.categories where slug = 'meals'), 800, '12 dumplings', 'Demo dish: see the description.', true, false, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('bc7dcac7-d797-5743-8ad6-d5e916de733b', '/demo/mei-vegdump.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'bc7dcac7-d797-5743-8ad6-d5e916de733b', code, case when code in ('cereals_gluten', 'soya', 'sesame') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('7ebf50a2-4ca0-5210-8438-3895b8c0ad8a', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'Scallion pancakes', 'Flaky, crispy and very moreish.', (select id from food.categories where slug = 'sides-snacks'), 500, '2 pancakes', 'Demo dish: see the description.', true, false, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('7ebf50a2-4ca0-5210-8438-3895b8c0ad8a', '/demo/mei-scallion.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '7ebf50a2-4ca0-5210-8438-3895b8c0ad8a', code, case when code in ('cereals_gluten') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('35f337a3-3d1d-5177-b669-3513563c5d3b', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'Sesame balls', 'Chewy glutinous rice with red bean filling.', (select id from food.categories where slug = 'desserts'), 400, '6 pieces', 'Demo dish: see the description.', true, false, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('35f337a3-3d1d-5177-b669-3513563c5d3b', '/demo/mei-sesame.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '35f337a3-3d1d-5177-b669-3513563c5d3b', code, case when code in ('sesame') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('38b92b16-49ff-5960-82dd-df0554688c71', null, '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'completed', 'collection', 'Demo customer', 850, 0, 850, 85, now() - interval '40 days', now() - interval '40 days', now() - interval '40 days', now() - interval '40 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('38b92b16-49ff-5960-82dd-df0554688c71', 'd13234ea-d763-5cfb-8486-d41c7587c682', 1, 'Pork and chive dumplings', 850, 1, 850);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('38b92b16-49ff-5960-82dd-df0554688c71', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', null, 'Jess', 5, 'Ordered for a family dinner and everyone loved it.', null, null, now() - interval '39 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('772a667a-da20-5159-a3b1-220f69e999bd', null, '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'completed', 'collection', 'Demo customer', 800, 0, 800, 80, now() - interval '12 days', now() - interval '12 days', now() - interval '12 days', now() - interval '12 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('772a667a-da20-5159-a3b1-220f69e999bd', 'bc7dcac7-d797-5743-8ad6-d5e916de733b', 1, 'Vegetable dumplings', 800, 1, 800);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('772a667a-da20-5159-a3b1-220f69e999bd', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', null, 'Kwame', 4, 'Very good, would like a bigger portion of the sides.', null, null, now() - interval '11 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('7f515426-c173-560b-bef7-f79e57ef14ab', null, '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'completed', 'collection', 'Demo customer', 500, 0, 500, 50, now() - interval '4 days', now() - interval '4 days', now() - interval '4 days', now() - interval '4 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('7f515426-c173-560b-bef7-f79e57ef14ab', '7ebf50a2-4ca0-5210-8438-3895b8c0ad8a', 1, 'Scallion pancakes', 500, 1, 500);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('7f515426-c173-560b-bef7-f79e57ef14ab', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', null, 'Priya', 4, 'Great value for the size.', null, null, now() - interval '3 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('b6520409-6275-5f36-9cd2-8e2536e6390d', null, '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'completed', 'collection', 'Demo customer', 400, 0, 400, 40, now() - interval '24 days', now() - interval '24 days', now() - interval '24 days', now() - interval '24 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('b6520409-6275-5f36-9cd2-8e2536e6390d', '35f337a3-3d1d-5177-b669-3513563c5d3b', 1, 'Sesame balls', 400, 1, 400);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('b6520409-6275-5f36-9cd2-8e2536e6390d', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', null, 'Ben', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '23 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('f7826855-ad8a-5e20-993a-e8ce660c7c2b', null, '2d4f6211-a979-5d08-8005-29c68d5a4b6c', 'completed', 'collection', 'Demo customer', 850, 0, 850, 85, now() - interval '7 days', now() - interval '7 days', now() - interval '7 days', now() - interval '7 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('f7826855-ad8a-5e20-993a-e8ce660c7c2b', 'd13234ea-d763-5cfb-8486-d41c7587c682', 1, 'Pork and chive dumplings', 850, 1, 850);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('f7826855-ad8a-5e20-993a-e8ce660c7c2b', '2d4f6211-a979-5d08-8005-29c68d5a4b6c', null, 'Nadia', 3, 'Nice but took longer than I expected.', null, null, now() - interval '6 days');
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('fc54f8b1-01eb-5d87-8d3f-19dc31701953', null, 'approved', 'Sweet Layers by Hana (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'fc54f8b1-01eb-5d87-8d3f-19dc31701953', 'demo-sweet-layers', 'Sweet Layers by Hana', 'Celebration cakes and everyday bakes from my home kitchen in Hackney. Order whole cakes two days ahead.', '/demo/hana-logo.svg', '/demo/hana-cover.svg', array['Cakes', 'Bakes'], 'Hackney, E8', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'Demo address (not real)', 'London', 'E8 1AA', 'This is a demo shop.', 51.545, -0.055);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence, delivery_radius_miles, radius_fee_pence, radius_min_order_pence)
values ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', true, true, 0, 4, 400, 2000);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 3, '10:00', '18:00'), ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 4, '10:00', '18:00'), ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 5, '10:00', '18:00'), ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 6, '10:00', '18:00');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'Chocolate fudge cake', 'Three layers of chocolate sponge with fudge icing. Order 2 days ahead.', (select id from food.categories where slug = 'cakes-bakes'), 2800, 'Whole cake', 'Demo dish: see the description.', true, true, null, 48, array['vegetarian']::text[]);
insert into food.product_images (product_id, path, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', '/demo/hana-choc.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '0bcf8c3f-1937-5b36-bb54-22b065369b59', code, case when code in ('cereals_gluten', 'eggs', 'milk', 'soya') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', 'Size', '6 inch (8 slices)', 0, 0);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', 'Size', '8 inch (12 slices)', 1000, 1);
insert into food.product_variants (product_id, group_name, name, price_delta_pence, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', 'Size', '10 inch (20 slices)', 2200, 2);
insert into food.product_addons (product_id, name, price_pence, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', 'Message on top', 300, 0);
insert into food.product_addons (product_id, name, price_pence, sort) values ('0bcf8c3f-1937-5b36-bb54-22b065369b59', 'Candles', 100, 1);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('b437dd8a-541b-5354-952b-9867c157436e', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'Victoria sponge slice', 'Jam, cream and a proper sponge.', (select id from food.categories where slug = 'cakes-bakes'), 350, '1 slice', 'Demo dish: see the description.', true, true, null, 0, array['vegetarian']::text[]);
insert into food.product_images (product_id, path, sort) values ('b437dd8a-541b-5354-952b-9867c157436e', '/demo/hana-vic.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'b437dd8a-541b-5354-952b-9867c157436e', code, case when code in ('cereals_gluten', 'eggs', 'milk') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('9bc1e504-1c25-52b2-8a26-23641ce2796b', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'Red velvet cupcakes', 'With cream cheese frosting.', (select id from food.categories where slug = 'cakes-bakes'), 1500, 'Box of 6', 'Demo dish: see the description.', true, true, null, 24, array['vegetarian']::text[]);
insert into food.product_images (product_id, path, sort) values ('9bc1e504-1c25-52b2-8a26-23641ce2796b', '/demo/hana-cupcake.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '9bc1e504-1c25-52b2-8a26-23641ce2796b', code, case when code in ('cereals_gluten', 'eggs', 'milk') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('9a9cc971-3dd7-5aba-b1f7-4e6d875b7248', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'Vegan banana bread', 'Loaf of banana bread with walnuts. No eggs or dairy.', (select id from food.categories where slug = 'cakes-bakes'), 900, 'Whole loaf', 'Demo dish: see the description.', true, true, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('9a9cc971-3dd7-5aba-b1f7-4e6d875b7248', '/demo/hana-banana.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '9a9cc971-3dd7-5aba-b1f7-4e6d875b7248', code, case when code in ('cereals_gluten', 'tree_nuts') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('fcf9f2dc-aaec-5c66-894a-0028143cdaf7', null, '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'completed', 'collection', 'Demo customer', 2800, 0, 2800, 280, now() - interval '21 days', now() - interval '21 days', now() - interval '21 days', now() - interval '21 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('fcf9f2dc-aaec-5c66-894a-0028143cdaf7', '0bcf8c3f-1937-5b36-bb54-22b065369b59', 1, 'Chocolate fudge cake', 2800, 1, 2800);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('fcf9f2dc-aaec-5c66-894a-0028143cdaf7', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', null, 'Ben', 5, 'Tastes like home. Thank you!', null, null, now() - interval '20 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('fbe58074-18ad-5f9c-8ea9-d5bde485dc92', null, '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'completed', 'collection', 'Demo customer', 350, 0, 350, 35, now() - interval '26 days', now() - interval '26 days', now() - interval '26 days', now() - interval '26 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('fbe58074-18ad-5f9c-8ea9-d5bde485dc92', 'b437dd8a-541b-5354-952b-9867c157436e', 1, 'Victoria sponge slice', 350, 1, 350);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('fbe58074-18ad-5f9c-8ea9-d5bde485dc92', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', null, 'Mira', 5, 'Honestly the best I have had in London. Will be ordering again!', null, null, now() - interval '25 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('bf3ae43e-5d4d-5406-9cb7-75373f76590d', null, '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 'completed', 'collection', 'Demo customer', 1500, 0, 1500, 150, now() - interval '24 days', now() - interval '24 days', now() - interval '24 days', now() - interval '24 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('bf3ae43e-5d4d-5406-9cb7-75373f76590d', '9bc1e504-1c25-52b2-8a26-23641ce2796b', 1, 'Red velvet cupcakes', 1500, 1, 1500);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('bf3ae43e-5d4d-5406-9cb7-75373f76590d', '8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', null, 'Nadia', 4, 'Really tasty, a bit spicy for me but I will be back.', 'Thank you so much! See you next time.', now(), now() - interval '23 days');
insert into food.seller_accounts (id, user_id, status, legal_name, business_type, charges_enabled, payouts_enabled, is_demo, terms_version, terms_accepted_at, approved_at)
values ('92bebdb0-2dd3-59ab-af6e-2f488921d78a', null, 'approved', 'Green Bowl Co (demo)', 'sole_trader', true, true, true, 'demo', now(), now());
insert into food.shops (id, seller_account_id, slug, name, story, logo_path, cover_path, cuisines, area_label, status, accepting_orders, is_demo)
values ('bf05b5c0-b192-557f-9476-5bffd7887880', '92bebdb0-2dd3-59ab-af6e-2f488921d78a', 'demo-green-bowl', 'Green Bowl Co', 'Plant-based comfort food that keeps you full. No meat, no dairy, lots of flavour.', '/demo/green-logo.svg', '/demo/green-cover.svg', array['Vegan', 'Healthy'], 'Leyton, E10', 'live', true, true);
insert into food.shop_private (shop_id, address_line1, city, postcode, collection_instructions, lat, lng)
values ('bf05b5c0-b192-557f-9476-5bffd7887880', 'Demo address (not real)', 'London', 'E10 5AA', 'This is a demo shop.', 51.56, -0.008);
insert into food.shop_settings (shop_id, offers_collection, offers_delivery, min_order_pence, delivery_radius_miles, radius_fee_pence, radius_min_order_pence)
values ('bf05b5c0-b192-557f-9476-5bffd7887880', true, true, 0, 3, 250, 1000);
insert into food.shop_hours (shop_id, weekday, opens, closes) values ('bf05b5c0-b192-557f-9476-5bffd7887880', 0, '11:00', '19:00'), ('bf05b5c0-b192-557f-9476-5bffd7887880', 1, '11:00', '19:00'), ('bf05b5c0-b192-557f-9476-5bffd7887880', 2, '11:00', '19:00'), ('bf05b5c0-b192-557f-9476-5bffd7887880', 3, '11:00', '19:00'), ('bf05b5c0-b192-557f-9476-5bffd7887880', 4, '11:00', '19:00');
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('9ce9879e-6ae5-5a4e-9ce6-9bd1556e1239', 'bf05b5c0-b192-557f-9476-5bffd7887880', 'Red lentil dahl and rice', 'Coconut dahl with turmeric and spinach.', (select id from food.categories where slug = 'meals'), 800, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('9ce9879e-6ae5-5a4e-9ce6-9bd1556e1239', '/demo/green-dahl.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '9ce9879e-6ae5-5a4e-9ce6-9bd1556e1239', code, case when code in ('mustard') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.product_addons (product_id, name, price_pence, sort) values ('9ce9879e-6ae5-5a4e-9ce6-9bd1556e1239', 'Garlic flatbread', 200, 0);
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('ddd07bcc-0bc4-54a3-82c8-9e0b3aa4d1d5', 'bf05b5c0-b192-557f-9476-5bffd7887880', 'Buddha bowl', 'Roast veg, quinoa, hummus and tahini dressing.', (select id from food.categories where slug = 'meals'), 900, 'Serves 1', 'Demo dish: see the description.', true, true, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('ddd07bcc-0bc4-54a3-82c8-9e0b3aa4d1d5', '/demo/green-buddha.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'ddd07bcc-0bc4-54a3-82c8-9e0b3aa4d1d5', code, case when code in ('sesame') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('3427a7f8-98c5-5f5a-8427-495638da36b7', 'bf05b5c0-b192-557f-9476-5bffd7887880', 'Chickpea curry meal prep', 'Five portions for the week, chilled.', (select id from food.categories where slug = 'meal-prep'), 2800, '5 portions', 'Demo dish: see the description.', true, true, null, 24, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('3427a7f8-98c5-5f5a-8427-495638da36b7', '/demo/green-chickpea.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select '3427a7f8-98c5-5f5a-8427-495638da36b7', code, case when code in ('-') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.products (id, shop_id, name, description, category_id, price_pence, portion, ingredients, collection_ok, delivery_ok, stock_qty, min_lead_hours, dietary)
values ('e5ed90c9-c42b-510c-b118-2a2a2669d093', 'bf05b5c0-b192-557f-9476-5bffd7887880', 'Date energy balls', 'Dates, oats, cocoa and almonds.', (select id from food.categories where slug = 'desserts'), 400, '6 balls', 'Demo dish: see the description.', true, true, null, 0, array['vegan']::text[]);
insert into food.product_images (product_id, path, sort) values ('e5ed90c9-c42b-510c-b118-2a2a2669d093', '/demo/green-balls.svg', 0);
insert into food.product_allergens (product_id, allergen_code, presence) select 'e5ed90c9-c42b-510c-b118-2a2a2669d093', code, case when code in ('tree_nuts', 'cereals_gluten') then 'contains'::food.allergen_presence else 'not_present'::food.allergen_presence end from food.allergens;
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('ff67c914-ee82-5f2f-ae3f-25800f5c5ff9', null, 'bf05b5c0-b192-557f-9476-5bffd7887880', 'completed', 'collection', 'Demo customer', 800, 0, 800, 80, now() - interval '20 days', now() - interval '20 days', now() - interval '20 days', now() - interval '20 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('ff67c914-ee82-5f2f-ae3f-25800f5c5ff9', '9ce9879e-6ae5-5a4e-9ce6-9bd1556e1239', 1, 'Red lentil dahl and rice', 800, 1, 800);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('ff67c914-ee82-5f2f-ae3f-25800f5c5ff9', 'bf05b5c0-b192-557f-9476-5bffd7887880', null, 'Chris', 5, 'Arrived hot and on time. Perfect.', 'Thank you so much! See you next time.', now(), now() - interval '19 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('237ac21e-a8e2-5024-ae43-9c847ed3af27', null, 'bf05b5c0-b192-557f-9476-5bffd7887880', 'completed', 'collection', 'Demo customer', 900, 0, 900, 90, now() - interval '33 days', now() - interval '33 days', now() - interval '33 days', now() - interval '33 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('237ac21e-a8e2-5024-ae43-9c847ed3af27', 'ddd07bcc-0bc4-54a3-82c8-9e0b3aa4d1d5', 1, 'Buddha bowl', 900, 1, 900);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('237ac21e-a8e2-5024-ae43-9c847ed3af27', 'bf05b5c0-b192-557f-9476-5bffd7887880', null, 'Chris', 3, 'Nice but took longer than I expected.', 'So glad you enjoyed it!', now(), now() - interval '32 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('9d43ac93-338d-5525-ba21-0a50952ffe99', null, 'bf05b5c0-b192-557f-9476-5bffd7887880', 'completed', 'collection', 'Demo customer', 2800, 0, 2800, 280, now() - interval '29 days', now() - interval '29 days', now() - interval '29 days', now() - interval '29 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('9d43ac93-338d-5525-ba21-0a50952ffe99', '3427a7f8-98c5-5f5a-8427-495638da36b7', 1, 'Chickpea curry meal prep', 2800, 1, 2800);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('9d43ac93-338d-5525-ba21-0a50952ffe99', 'bf05b5c0-b192-557f-9476-5bffd7887880', null, 'Omar', 5, 'Proper homemade food, you can tell.', null, null, now() - interval '28 days');
insert into food.orders (id, customer_id, shop_id, status, fulfilment, customer_name, subtotal_pence, delivery_fee_pence, total_pence, platform_fee_pence, created_at, paid_at, accepted_at, completed_at)
values ('b0388288-553f-5152-81d8-cf8744259e9b', null, 'bf05b5c0-b192-557f-9476-5bffd7887880', 'completed', 'collection', 'Demo customer', 400, 0, 400, 40, now() - interval '24 days', now() - interval '24 days', now() - interval '24 days', now() - interval '24 days');
insert into food.order_items (order_id, product_id, product_version, name, unit_price_pence, qty, line_total_pence) values ('b0388288-553f-5152-81d8-cf8744259e9b', 'e5ed90c9-c42b-510c-b118-2a2a2669d093', 1, 'Date energy balls', 400, 1, 400);
insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, seller_reply, seller_replied_at, created_at)
values ('b0388288-553f-5152-81d8-cf8744259e9b', 'bf05b5c0-b192-557f-9476-5bffd7887880', null, 'Chris', 4, 'Lovely food, collection was easy.', null, null, now() - interval '23 days');
update food.products set status = 'published', allergens_confirmed_at = now() where shop_id in (select id from food.shops where is_demo);
-- Three demo shops are featured, so the sponsored spots can be seen.
insert into food.promotions (shop_id, weeks, status, starts_on, ends_on, fee_pence, decided_at) values ('960ebaa8-5eb5-5c89-a1cd-c4bbe4f139c4', 4, 'active', current_date, current_date + 27, 0, now());
insert into food.promotions (shop_id, weeks, status, starts_on, ends_on, fee_pence, decided_at) values ('c915ca7b-2fce-51bb-b49f-1b1957a46a84', 4, 'active', current_date, current_date + 27, 0, now());
insert into food.promotions (shop_id, weeks, status, starts_on, ends_on, fee_pence, decided_at) values ('8f64ac06-2ee4-5ac6-9b76-e529a7c564dc', 4, 'active', current_date, current_date + 27, 0, now());


alter table food.orders enable trigger orders_notify;
alter table food.reviews enable trigger reviews_notify;

-- Demo shops can't take real orders.
create function food.block_demo_orders() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from food.shops where id = new.shop_id and is_demo) then
    raise exception 'This is a demo shop to show how BiteBY works, so it can''t take orders.';
  end if;
  return new;
end $$;
create trigger orders_block_demo before insert on food.orders
  for each row execute function food.block_demo_orders();

-- Removes every demo shop and everything attached to it.
create function food.admin_remove_demo_data() returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  select count(*) into v_count from food.shops where is_demo;
  delete from food.orders where shop_id in (select id from food.shops where is_demo);
  delete from food.products where shop_id in (select id from food.shops where is_demo);
  delete from food.shops where is_demo;
  delete from food.seller_accounts where is_demo;
  insert into food.audit_log (actor_id, actor_role, action, target_table, reason)
  values (auth.uid(), 'admin', 'demo_data_removed', 'shops', v_count || ' demo shops');
  return v_count;
end $$;
revoke execute on function food.admin_remove_demo_data() from public, anon;
grant execute on function food.admin_remove_demo_data() to authenticated;
