-- Review photos, "dishes I loved" in reviews, and rough shop locations for
-- the Explore map.

-- ---------- Reviews ----------
alter table food.reviews add column photo_path text check (char_length(photo_path) <= 200);
alter table food.reviews add column loved_products uuid[] not null default '{}' check (cardinality(loved_products) <= 20);

drop function food.leave_review(uuid, int, text);
create function food.leave_review(p_order uuid, p_rating int, p_comment text default null,
                                  p_photo text default null, p_loved uuid[] default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order food.orders;
  v_loved uuid[];
begin
  select * into v_order from food.orders where id = p_order and customer_id = auth.uid();
  if not found then
    raise exception 'Order not found';
  end if;
  if v_order.status <> 'completed' then
    raise exception 'You can review an order once it is complete';
  end if;
  if v_order.completed_at < now() - interval '30 days' then
    raise exception 'Reviews can be left up to 30 days after an order';
  end if;
  if p_rating not between 1 and 5 then
    raise exception 'Choose 1 to 5 stars';
  end if;
  -- Photos go in the reviewer's own folder, which only they can upload to.
  if p_photo is not null and (p_photo not like auth.uid()::text || '/%' or p_photo like '%..%') then
    raise exception 'That photo can''t be used';
  end if;
  -- Only dishes that were on this order.
  select coalesce(array_agg(distinct i.product_id), '{}') into v_loved
    from food.order_items i where i.order_id = p_order and i.product_id = any (coalesce(p_loved, '{}'));
  insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment, photo_path, loved_products)
  values (p_order, v_order.shop_id, auth.uid(),
          left(split_part(trim(v_order.customer_name), ' ', 1), 40),
          p_rating, nullif(trim(p_comment), ''), p_photo, v_loved);
exception when unique_violation then
  raise exception 'You have already reviewed this order';
end $$;
revoke execute on function food.leave_review(uuid, int, text, text, uuid[]) from public, anon;
grant execute on function food.leave_review(uuid, int, text, text, uuid[]) to authenticated;

-- How many reviewers loved each dish.
create function food.dish_loved_counts(p_products uuid[]) returns table (product_id uuid, loved int)
language sql stable security definer set search_path = '' as $$
  select p, count(*)::int
    from food.reviews r, unnest(r.loved_products) p
   where p = any (p_products[1:200]) and not r.hidden and food.shop_is_public(r.shop_id)
   group by p
$$;
revoke execute on function food.dish_loved_counts(uuid[]) from public;
grant execute on function food.dish_loved_counts(uuid[]) to anon, authenticated;

-- ---------- Map ----------
-- Shop locations rounded to about a kilometre, so a home address is never shown.
create function food.shops_map() returns table (shop_id uuid, lat double precision, lng double precision)
language sql stable security definer set search_path = '' as $$
  select s.id, round(p.lat::numeric, 2)::double precision, round(p.lng::numeric, 2)::double precision
    from food.shops s join food.shop_private p on p.shop_id = s.id
   where food.shop_is_public(s.id) and p.lat is not null and p.lng is not null
   limit 2000
$$;
revoke execute on function food.shops_map() from public;
grant execute on function food.shops_map() to anon, authenticated;

-- ---------- Account deletion also unlinks review photos ----------
create or replace function food.delete_my_account() returns void
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
  update food.reviews set reviewer_name = 'Former customer', photo_path = null where customer_id = v_user;
  update food.profiles set display_name = null, phone = null, avatar_path = null, marketing_consent = false, marketing_consent_at = null where id = v_user;
  delete from food.addresses where user_id = v_user;
  delete from food.favourites where user_id = v_user;
  delete from food.notifications where user_id = v_user;
  delete from food.order_messages where sender_id = v_user;
  delete from food.shop_chats where customer_id = v_user;
  insert into food.account_deletions (user_id) values (v_user) on conflict do nothing;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id)
  values (v_user, 'customer', 'account_deletion_requested', 'auth.users', v_user::text);
end $$;

-- ---------- Demo shops: loved dishes on their past reviews ----------
update food.reviews r
   set loved_products = coalesce((select array_agg(distinct i.product_id) from food.order_items i where i.order_id = r.order_id and i.product_id is not null), '{}')
 where r.shop_id in (select id from food.shops where is_demo);
-- and a photo (the dish picture) on their 5-star reviews.
update food.reviews r
   set photo_path = (select i.path from food.product_images i where i.product_id = r.loved_products[1] order by i.sort limit 1)
 where r.shop_id in (select id from food.shops where is_demo) and r.rating = 5 and cardinality(r.loved_products) > 0;
