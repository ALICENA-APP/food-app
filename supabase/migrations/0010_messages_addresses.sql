-- Order chat between the customer and the cook, and saved delivery
-- addresses. Messages are kept for 180 days to keep the database small.

create table food.order_messages (
  id bigint generated always as identity primary key,
  order_id uuid not null references food.orders (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  from_seller boolean not null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index on food.order_messages (order_id, created_at);
alter table food.order_messages enable row level security;
grant select on food.order_messages to authenticated;
create policy "order messages: people on the order" on food.order_messages
  for select to authenticated using (food.can_see_order(order_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table food.order_messages;
  end if;
end $$;

-- Sends a message on an order. The customer and the cook can chat once the
-- order has reached the cook, and for 7 days after it ends.
create function food.send_order_message(p_order uuid, p_body text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  o food.orders;
  v_seller boolean;
  v_shop text;
  v_body text := btrim(p_body);
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
end $$;
revoke execute on function food.send_order_message(uuid, text) from public, anon;
grant execute on function food.send_order_message(uuid, text) to authenticated;

-- Saved delivery addresses (up to 5 each).
create table food.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text check (char_length(label) <= 40),
  address text not null check (char_length(address) between 3 and 300),
  postcode text not null check (char_length(postcode) between 2 and 10),
  created_at timestamptz not null default now()
);
create index on food.addresses (user_id);
alter table food.addresses enable row level security;
grant select, delete on food.addresses to authenticated;
grant insert (id, label, address, postcode), update (label, address, postcode) on food.addresses to authenticated;
create policy "addresses: own" on food.addresses
  for select to authenticated using (user_id = auth.uid());
create policy "addresses: add own" on food.addresses
  for insert to authenticated with check (user_id = auth.uid());
create policy "addresses: edit own" on food.addresses
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "addresses: remove own" on food.addresses
  for delete to authenticated using (user_id = auth.uid());

create function food.limit_addresses() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from food.addresses where user_id = new.user_id) >= 5 then
    raise exception 'You can save up to 5 addresses';
  end if;
  return new;
end $$;
create trigger addresses_limit before insert on food.addresses
  for each row execute function food.limit_addresses();

-- Tidy-up now also clears old order messages.
create or replace function food.expire_stale_orders() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update food.orders set status = 'expired'
   where status = 'awaiting_payment' and created_at < now() - interval '2 hours';
  update food.orders o set status = 'expired'
    from food.shop_settings s
   where o.status = 'pending_acceptance' and s.shop_id = o.shop_id
     and coalesce(o.paid_at, o.created_at) < now() - make_interval(mins => s.acceptance_window_minutes);
  delete from food.notifications where created_at < now() - interval '90 days';
  delete from food.order_messages where created_at < now() - interval '180 days';
end $$;
