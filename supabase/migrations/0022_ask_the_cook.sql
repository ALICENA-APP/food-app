-- "Ask the cook": a customer can message a cook before ordering, for example
-- about allergies. One conversation per customer and shop. Messages are kept
-- for 180 days, and contact details or payment outside BiteBY are taken out.

create table food.shop_chats (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references food.shops (id) on delete cascade,
  customer_id uuid not null references auth.users (id) on delete cascade,
  customer_name text not null check (char_length(customer_name) between 1 and 80),
  product_id uuid references food.products (id) on delete set null,
  created_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  customer_read_at timestamptz not null default now(),
  seller_read_at timestamptz,
  unique (shop_id, customer_id)
);
create index on food.shop_chats (shop_id, last_message_at desc);
alter table food.shop_chats enable row level security;
grant select on food.shop_chats to authenticated;
create policy "shop chats: customer or cook" on food.shop_chats for select to authenticated
  using (customer_id = auth.uid() or food.owns_shop(shop_id));

create table food.shop_chat_messages (
  id bigint generated always as identity primary key,
  chat_id uuid not null references food.shop_chats (id) on delete cascade,
  sender_id uuid references auth.users (id) on delete set null, -- null: an automatic reply
  from_seller boolean not null,
  body text not null check (char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index on food.shop_chat_messages (chat_id, created_at);
alter table food.shop_chat_messages enable row level security;
grant select on food.shop_chat_messages to authenticated;
create policy "shop chat messages: customer or cook" on food.shop_chat_messages for select to authenticated
  using (exists (select 1 from food.shop_chats c where c.id = chat_id and (c.customer_id = auth.uid() or food.owns_shop(c.shop_id))));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table food.shop_chat_messages;
  end if;
end $$;

-- Adds one message to a conversation, with the same safety checks as order chat.
create function food.post_chat_message(p_chat food.shop_chats, p_seller boolean, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_reason text;
  v_note text;
  v_shop text;
begin
  if char_length(v_body) = 0 then raise exception 'Write a message first'; end if;
  if (select count(*) from food.shop_chat_messages m join food.shop_chats c on c.id = m.chat_id
       where m.sender_id = auth.uid() and m.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many messages. Please wait a little.';
  end if;
  v_reason := food.off_app_reason(v_body);
  if v_reason is not null then
    insert into food.safety_flags (user_id, shop_id, source, reason, excerpt)
    values (auth.uid(), p_chat.shop_id, case when p_seller then 'seller question reply' else 'customer question' end, v_reason, left(v_body, 300));
    v_body := food.redact_contact(v_body);
    v_note := 'For everyone''s safety, contact details and payment outside BiteBY aren''t allowed in messages, so part of your message was hidden.';
  end if;
  insert into food.shop_chat_messages (chat_id, sender_id, from_seller, body) values (p_chat.id, auth.uid(), p_seller, left(v_body, 1000));
  update food.shop_chats set last_message_at = now(),
         customer_read_at = case when p_seller then customer_read_at else now() end,
         seller_read_at = case when p_seller then now() else seller_read_at end
   where id = p_chat.id;

  select name into v_shop from food.shops where id = p_chat.shop_id;
  if p_seller then
    insert into food.notifications (user_id, title, body, link)
    values (p_chat.customer_id, 'Reply from ' || v_shop, left(v_body, 300), '/messages/' || p_chat.id);
  elsif food.shop_owner(p_chat.shop_id) is not null then
    insert into food.notifications (user_id, title, body, link)
    values (food.shop_owner(p_chat.shop_id), 'Question from ' || p_chat.customer_name, left(v_body, 300), '/sell/questions?chat=' || p_chat.id);
  end if;
  return v_note;
end $$;
revoke execute on function food.post_chat_message(food.shop_chats, boolean, text) from public, anon, authenticated;

-- A customer asks a cook something. Starts the conversation the first time.
create function food.ask_cook(p_shop uuid, p_body text, p_product uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  c food.shop_chats;
  v_name text;
  v_demo boolean;
  v_note text;
begin
  if auth.uid() is null then raise exception 'Sign in to message the cook'; end if;
  if not food.shop_is_public(p_shop) then raise exception 'This shop isn''t open on BiteBY right now'; end if;
  if food.owns_shop(p_shop) then raise exception 'This is your own shop'; end if;
  select * into c from food.shop_chats where shop_id = p_shop and customer_id = auth.uid();
  if not found then
    if (select count(*) from food.shop_chats where customer_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
      raise exception 'You''ve started a lot of conversations today. Please try again tomorrow.';
    end if;
    select coalesce(nullif(trim(p.display_name), ''), 'A customer') into v_name from food.profiles p where p.id = auth.uid();
    insert into food.shop_chats (shop_id, customer_id, customer_name, product_id)
    values (p_shop, auth.uid(), left(coalesce(v_name, 'A customer'), 80),
            (select id from food.products where id = p_product and shop_id = p_shop))
    returning * into c;
  elsif p_product is not null then
    update food.shop_chats set product_id = (select id from food.products where id = p_product and shop_id = p_shop) where id = c.id
    returning * into c;
  end if;
  v_note := food.post_chat_message(c, false, p_body);

  -- Demo cooks can't answer, so they say so straight away.
  select is_demo into v_demo from food.shops where id = p_shop;
  if v_demo and (select count(*) from food.shop_chat_messages where chat_id = c.id and from_seller) = 0 then
    insert into food.shop_chat_messages (chat_id, sender_id, from_seller, body)
    values (c.id, null, true, 'Thanks for your message! This is a demo shop, so nobody will reply. On a real shop, the cook answers here and you get an alert.');
  end if;
  return jsonb_build_object('chat_id', c.id, 'note', v_note);
end $$;
revoke execute on function food.ask_cook(uuid, text, uuid) from public, anon;
grant execute on function food.ask_cook(uuid, text, uuid) to authenticated;

-- Either side replies in an existing conversation.
create function food.send_chat_message(p_chat uuid, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  c food.shop_chats;
  v_seller boolean;
begin
  select * into c from food.shop_chats where id = p_chat;
  if not found then raise exception 'Conversation not found'; end if;
  v_seller := food.owns_shop(c.shop_id);
  if not v_seller and c.customer_id is distinct from auth.uid() then raise exception 'Not your conversation'; end if;
  if not v_seller and not food.shop_is_public(c.shop_id) then raise exception 'This shop isn''t open on BiteBY right now'; end if;
  return food.post_chat_message(c, v_seller, p_body);
end $$;
revoke execute on function food.send_chat_message(uuid, text) from public, anon;
grant execute on function food.send_chat_message(uuid, text) to authenticated;

create function food.mark_chat_read(p_chat uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  c food.shop_chats;
begin
  select * into c from food.shop_chats where id = p_chat;
  if not found then return; end if;
  if food.owns_shop(c.shop_id) then
    update food.shop_chats set seller_read_at = now() where id = p_chat;
  elsif c.customer_id = auth.uid() then
    update food.shop_chats set customer_read_at = now() where id = p_chat;
  end if;
end $$;
revoke execute on function food.mark_chat_read(uuid) from public, anon;
grant execute on function food.mark_chat_read(uuid) to authenticated;

-- Tidy-up also clears old questions.
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
  delete from food.shop_chat_messages where created_at < now() - interval '180 days';
  delete from food.shop_chats c where c.last_message_at < now() - interval '180 days';
end $$;

-- Deleting an account also removes its questions to cooks.
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
  update food.reviews set reviewer_name = 'Former customer' where customer_id = v_user;
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
