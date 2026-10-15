-- Reviews: only from a customer whose order was completed, one per order,
-- within 30 days. Sellers can reply once; admins can hide a review.

create table food.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references food.orders (id) on delete cascade,
  shop_id uuid not null references food.shops (id) on delete cascade,
  customer_id uuid not null references auth.users (id) on delete cascade,
  reviewer_name text not null check (char_length(reviewer_name) <= 40),  -- first name only
  rating smallint not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 1000),
  seller_reply text check (char_length(seller_reply) <= 1000),
  seller_replied_at timestamptz,
  hidden boolean not null default false,
  hidden_reason text check (char_length(hidden_reason) <= 300),
  created_at timestamptz not null default now()
);
create index on food.reviews (shop_id, created_at desc);
alter table food.reviews enable row level security;
grant select on food.reviews to anon, authenticated;

create policy "reviews: public sees visible reviews of open shops" on food.reviews
  for select using (not hidden and food.shop_is_public(shop_id));
create policy "reviews: author, shop owner or admin" on food.reviews
  for select to authenticated
  using (customer_id = auth.uid() or food.owns_shop(shop_id) or food.is_admin());

create function food.leave_review(p_order uuid, p_rating int, p_comment text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_order food.orders;
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
  insert into food.reviews (order_id, shop_id, customer_id, reviewer_name, rating, comment)
  values (p_order, v_order.shop_id, auth.uid(),
          left(split_part(trim(v_order.customer_name), ' ', 1), 40),
          p_rating, nullif(trim(p_comment), ''));
exception when unique_violation then
  raise exception 'You have already reviewed this order';
end $$;

create function food.reply_to_review(p_review uuid, p_reply text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(trim(p_reply), '') = '' then
    raise exception 'Write a reply first';
  end if;
  update food.reviews set seller_reply = trim(p_reply), seller_replied_at = now()
   where id = p_review and food.owns_shop(shop_id) and seller_reply is null;
  if not found then
    raise exception 'You can reply once to reviews of your shop';
  end if;
end $$;

create function food.admin_hide_review(p_review uuid, p_hidden boolean, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if p_hidden and coalesce(trim(p_reason), '') = '' then
    raise exception 'Add a reason';
  end if;
  update food.reviews set hidden = p_hidden, hidden_reason = case when p_hidden then trim(p_reason) end
   where id = p_review;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, after)
  values (auth.uid(), 'admin', case when p_hidden then 'review_hidden' else 'review_shown' end,
          'reviews', p_review::text, p_reason, jsonb_build_object('hidden', p_hidden));
end $$;

-- Average rating and count of visible reviews, for shop pages and lists.
create function food.shop_ratings(p_shops uuid[])
returns table (shop_id uuid, average numeric, reviews integer)
language sql stable security definer set search_path = '' as $$
  select r.shop_id, round(avg(r.rating), 1), count(*)::int
    from food.reviews r
   where r.shop_id = any (p_shops) and not r.hidden and food.shop_is_public(r.shop_id)
   group by r.shop_id
$$;

-- Admin cancels an order that hasn't been accepted yet (e.g. a problem
-- order). Refunds are handled with Stripe once payments are switched on.
create function food.admin_cancel_order(p_order uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before food.order_status;
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Add a reason';
  end if;
  select status into v_before from food.orders where id = p_order for update;
  if v_before is null or v_before not in ('awaiting_payment', 'pending_acceptance') then
    raise exception 'Only orders not yet accepted can be cancelled here';
  end if;
  update food.orders set status = 'cancelled', decline_reason = trim(p_reason) where id = p_order;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, before, after)
  values (auth.uid(), 'admin', 'order_cancelled', 'orders', p_order::text, p_reason,
          jsonb_build_object('status', v_before), jsonb_build_object('status', 'cancelled'));
end $$;

revoke execute on function
  food.leave_review(uuid, int, text), food.reply_to_review(uuid, text),
  food.admin_hide_review(uuid, boolean, text), food.admin_cancel_order(uuid, text)
from public, anon;
grant execute on function
  food.leave_review(uuid, int, text), food.reply_to_review(uuid, text),
  food.admin_hide_review(uuid, boolean, text), food.admin_cancel_order(uuid, text)
to authenticated;
grant execute on function food.shop_ratings(uuid[]) to anon, authenticated;
