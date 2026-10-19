-- Smarter "keep it on BiteBY" filter.
-- Before: "cash" was caught but only flagged (words weren't hidden), and
-- "C a sh", "CA$H", "c.a.s.h", "kash" or a word split over several messages
-- got through. Now the text is normalised first (look-alike symbols and
-- letters, spaces and dots between letters, doubled letters, number words),
-- the sender's last few messages are read together, and a message that would
-- take payment or contact off BiteBY isn't sent at all.

-- Lower-case letters only, with "|" between words: "CA$H!" -> "|cash|",
-- "c.a. sh" -> "|c|a|sh|". Common look-alikes become the letter they imitate.
create or replace function food.squash_words(p text) returns text
language sql immutable set search_path = '' as $$
  select '|' || regexp_replace(
    translate(lower(coalesce(p, '')),
      '|$@!013457€£аеорсхукміíìïîéèëêáàâäãóòôöõúùûüçñ',
      'isaioieastes' || 'aeopcxykmi' || 'iiii' || 'eeee' || 'aaaaa' || 'ooooo' || 'uuuu' || 'cn'),
    '[^a-z]+', '|', 'g') || '|'
$$;

-- A regex that finds a word in squash_words() output even when its letters
-- are split by spaces or symbols ("|c|a|sh|") or doubled ("|caash|"), as long
-- as it starts and ends on a word edge (so "cashew" and "Jamaica shrimp" are fine).
create or replace function food.word_pattern(p_word text) returns text
language sql immutable set search_path = '' as $$
  select '\|' || string_agg(
           '(?:' || case ch when 'c' then '[ck]' when 'k' then '[ck]' when 'i' then '[il]' when 'l' then '[il]' else ch end || '+\|?)+',
           '\|?' order by n) || '(?=\|)'
    from regexp_split_to_table(regexp_replace(p_word, '(.)\1+', '\1', 'g'), '') with ordinality as x(ch, n)
$$;

create or replace function food.off_app_reason(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  t text := lower(coalesce(p, ''));
  s text := food.squash_words(p);
  numbers text;
  digits text;
  w text;
begin
  if t ~ '[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+' then return 'an email address'; end if;
  if t ~ '(https?://|www\.|\.co\.uk\M|\.com\M|wa\.me|bit\.ly)' then return 'a website link'; end if;
  -- Phone numbers, also typed as words ("oh seven nine...").
  numbers := t;
  foreach w in array array['zero:0', 'oh:0', 'nought:0', 'one:1', 'two:2', 'three:3', 'four:4', 'five:5', 'six:6', 'seven:7', 'eight:8', 'nine:9'] loop
    numbers := regexp_replace(numbers, '\m' || split_part(w, ':', 1) || '\M', split_part(w, ':', 2), 'g');
  end loop;
  digits := regexp_replace(numbers, '[\s().,/_*-]', '', 'g');
  if digits ~ '(\+44|0044|07)\d{9}' or digits ~ '(^|\D)0[1-9]\d{8,9}($|\D)' then return 'a phone number'; end if;
  if t ~ '\m\d{2}-\d{2}-\d{2}\M' then return 'bank details'; end if;
  foreach w in array array['cash', 'kash', 'cashapp', 'paypal', 'revolut', 'monzo', 'starling', 'venmo', 'zelle',
      'banktransfer', 'bankdetails', 'sortcode', 'accountnumber', 'accno', 'iban',
      'paydirect', 'paydirectly', 'paymedirect', 'paymedirectly', 'payoutside', 'paymeoutside',
      'offtheapp', 'offapp', 'outsidetheapp', 'outsideoftheapp', 'outsideapp', 'outsidebiteby',
      'payinperson', 'payoncollection', 'payatcollection', 'payonpickup', 'payatthedoor', 'payatdoor',
      'payondelivery', 'moneyinhand'] loop
    if s ~ food.word_pattern(w) then return 'payment outside BiteBY'; end if;
  end loop;
  foreach w in array array['whatsapp', 'watsapp', 'whatsap', 'telegram', 'snapchat', 'instagram', 'insta',
      'facebook', 'tiktok', 'dmme'] loop
    if s ~ food.word_pattern(w) then return 'contact outside BiteBY'; end if;
  end loop;
  return null;
end $$;
grant execute on function food.off_app_reason(text) to anon, authenticated;

-- Same, but also reads the sender's recent messages together with the new
-- one, so "C" / "a" / "sh" sent one after another is caught on the last one.
create or replace function food.off_app_reason_with(p_recent text, p_new text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := food.off_app_reason(p_new);
begin
  if v is null and coalesce(p_recent, '') <> '' and food.off_app_reason(p_recent) is null then
    v := food.off_app_reason(p_recent || ' ' || p_new);
  end if;
  return v;
end $$;

create or replace function food.blocked_message_note(p_reason text) returns text
language sql immutable set search_path = '' as $$
  select 'Your message wasn''t sent because it looks like it mentions ' || p_reason
      || '. Please keep payment and chat on BiteBY: orders paid any other way aren''t protected.'
$$;

create or replace function food.send_order_message(p_order uuid, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  o food.orders;
  v_seller boolean;
  v_shop text;
  v_body text := btrim(p_body);
  v_recent text;
  v_reason text;
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
  -- Contact details and payment outside BiteBY: not sent, and flagged for the team.
  select string_agg(body, ' ' order by created_at) into v_recent from (
    select body, created_at from food.order_messages
     where order_id = p_order and sender_id = auth.uid() and created_at > now() - interval '30 minutes'
     order by created_at desc limit 6) r;
  v_reason := food.off_app_reason_with(v_recent, v_body);
  if v_reason is not null then
    insert into food.safety_flags (user_id, shop_id, order_id, source, reason, excerpt)
    values (auth.uid(), o.shop_id, p_order, case when v_seller then 'seller message' else 'customer message' end, v_reason,
            left(case when v_recent is null then v_body else v_recent || ' / ' || v_body end, 300));
    return food.blocked_message_note(v_reason);
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
  return null;
end $$;

create or replace function food.post_chat_message(p_chat food.shop_chats, p_seller boolean, p_body text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_recent text;
  v_reason text;
  v_shop text;
begin
  if char_length(v_body) = 0 then raise exception 'Write a message first'; end if;
  if (select count(*) from food.shop_chat_messages m join food.shop_chats c on c.id = m.chat_id
       where m.sender_id = auth.uid() and m.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Too many messages. Please wait a little.';
  end if;
  select string_agg(body, ' ' order by created_at) into v_recent from (
    select body, created_at from food.shop_chat_messages
     where chat_id = p_chat.id and sender_id = auth.uid() and created_at > now() - interval '30 minutes'
     order by created_at desc limit 6) r;
  v_reason := food.off_app_reason_with(v_recent, v_body);
  if v_reason is not null then
    insert into food.safety_flags (user_id, shop_id, source, reason, excerpt)
    values (auth.uid(), p_chat.shop_id, case when p_seller then 'seller question reply' else 'customer question' end, v_reason,
            left(case when v_recent is null then v_body else v_recent || ' / ' || v_body end, 300));
    return food.blocked_message_note(v_reason);
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
  return null;
end $$;
revoke execute on function food.post_chat_message(food.shop_chats, boolean, text) from public, anon, authenticated;

create or replace function food.ask_cook(p_shop uuid, p_body text, p_product uuid default null) returns jsonb
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

  if v_note is not null then
    -- Not sent: don't leave an empty conversation behind.
    delete from food.shop_chats where id = c.id and not exists (select 1 from food.shop_chat_messages where chat_id = c.id);
    return jsonb_build_object('chat_id', null, 'note', v_note, 'blocked', true);
  end if;

  -- Demo cooks can't answer, so they say so straight away.
  select is_demo into v_demo from food.shops where id = p_shop;
  if v_demo and (select count(*) from food.shop_chat_messages where chat_id = c.id and from_seller) = 0 then
    insert into food.shop_chat_messages (chat_id, sender_id, from_seller, body)
    values (c.id, null, true, 'Thanks for your message! This is a demo shop, so nobody will reply. On a real shop, the cook answers here and you get an alert.');
  end if;
  return jsonb_build_object('chat_id', c.id, 'note', null);
end $$;

-- Demo: what a stopped attempt looks like in Admin > Safety.
insert into food.safety_flags (shop_id, source, reason, excerpt, created_at)
select id, 'customer message', 'payment outside BiteBY', 'Can / Pay by c a $ h ? (demo: this message was stopped and never reached the cook)', now() - interval '3 hours'
  from food.shops where slug = 'demo-meis-dumplings';
