-- In-app alerts: sellers hear about new paid orders and reviews; customers
-- hear when their order moves on. Old alerts are cleared after 90 days to
-- keep the database small.

create table food.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) <= 120),
  body text check (char_length(body) <= 300),
  link text check (char_length(link) <= 200),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on food.notifications (user_id, created_at desc);
alter table food.notifications enable row level security;
grant select on food.notifications to authenticated;
grant update (read_at) on food.notifications to authenticated;
create policy "notifications: own" on food.notifications
  for select to authenticated using (user_id = auth.uid());
create policy "notifications: mark own read" on food.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Live updates in the app (Supabase Realtime), where available.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table food.notifications;
  end if;
end $$;

create function food.shop_owner(p_shop uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select a.user_id from food.shops s join food.seller_accounts a on a.id = s.seller_account_id where s.id = p_shop
$$;
revoke execute on function food.shop_owner(uuid) from public, anon, authenticated;

create function food.notify_order_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_shop text;
  v_link text := '/orders/' || new.id;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  select name into v_shop from food.shops where id = new.shop_id;
  case new.status
    when 'pending_acceptance' then
      insert into food.notifications (user_id, title, body, link)
      values (food.shop_owner(new.shop_id), 'New order ' || new.code,
              new.customer_name || ' · ' || new.fulfilment || ' · £' || to_char(new.total_pence / 100.0, 'FM999990.00'),
              '/sell/orders');
    when 'accepted' then
      insert into food.notifications (user_id, title, body, link)
      values (new.customer_id, v_shop || ' accepted your order', 'Order ' || new.code || ' is being made.', v_link);
    when 'declined' then
      insert into food.notifications (user_id, title, body, link)
      values (new.customer_id, v_shop || ' couldn''t take your order', new.decline_reason, v_link);
    when 'ready' then
      insert into food.notifications (user_id, title, body, link)
      values (new.customer_id, 'Your order is ready to collect', 'Order ' || new.code || ' from ' || v_shop, v_link);
    when 'out_for_delivery' then
      insert into food.notifications (user_id, title, body, link)
      values (new.customer_id, 'Your order is on its way', 'Order ' || new.code || ' from ' || v_shop, v_link);
    when 'completed' then
      insert into food.notifications (user_id, title, body, link)
      values (new.customer_id, 'Enjoy your food!', 'Tell others what you thought of ' || v_shop || '.', v_link);
    when 'cancelled', 'expired' then
      if tg_op = 'UPDATE' and old.status <> 'awaiting_payment' then
        insert into food.notifications (user_id, title, body, link)
        values (new.customer_id, 'Order ' || new.code || ' was ' || new.status::text,
                coalesce(new.decline_reason, 'The cook didn''t respond in time.'), v_link);
        insert into food.notifications (user_id, title, body, link)
        values (food.shop_owner(new.shop_id), 'Order ' || new.code || ' was ' || new.status::text, null, '/sell/orders');
      end if;
    else
      null;
  end case;
  return new;
end $$;
create trigger orders_notify after insert or update of status on food.orders
  for each row execute function food.notify_order_change();

create function food.notify_new_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into food.notifications (user_id, title, body, link)
  values (food.shop_owner(new.shop_id), 'New ' || new.rating || '-star review from ' || new.reviewer_name,
          left(new.comment, 300), '/sell/reviews');
  return new;
end $$;
create trigger reviews_notify after insert on food.reviews
  for each row execute function food.notify_new_review();

-- Tidy-up, run by the app when people open their orders (no scheduler is
-- needed): unpaid orders expire after 2 hours; paid orders a seller hasn't
-- answered expire after the shop's acceptance window (refunds come with
-- Stripe); old alerts are deleted.
create function food.expire_stale_orders() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update food.orders set status = 'expired'
   where status = 'awaiting_payment' and created_at < now() - interval '2 hours';
  update food.orders o set status = 'expired'
    from food.shop_settings s
   where o.status = 'pending_acceptance' and s.shop_id = o.shop_id
     and coalesce(o.paid_at, o.created_at) < now() - make_interval(mins => s.acceptance_window_minutes);
  delete from food.notifications where created_at < now() - interval '90 days';
end $$;
revoke execute on function food.expire_stale_orders() from public, anon;
grant execute on function food.expire_stale_orders() to authenticated;
