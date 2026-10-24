-- Six improvements:
--  1. Phone notifications (web push) for every alert.
--  2. "Problem with my order": the customer reports it with a photo, the cook
--     can refund in one tap, and BiteBY steps in if needed.
--  3. Bug alerts: errors people hit in the app are logged for the admin.
--  4. Town pages for Google ("Homemade food in Bow").
--  5. Order reminders: the cook is nudged after 15 minutes and the order is
--     cancelled if they haven't replied within an hour.
--  6. Reorder nudges: past customers hear when it's time to order again, and
--     cooks can send their regulars a short update once a week.
-- A job runner ties the timed parts together. It runs every minute inside
-- the database (pg_cron) and is also started by a Netlify timer and by the
-- app itself, so nothing depends on one timer.

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table food.platform_settings
  add column site_url text not null default 'https://food.beastcase.net' check (site_url ~ '^https://'),
  add column reply_minutes integer not null default 60 check (reply_minutes between 15 and 720);

-- Customers can turn off updates from cooks they've ordered from.
alter table food.profiles add column cook_updates boolean not null default true;
grant update (cook_updates) on food.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Order reminders and the one-hour reply deadline
-- ---------------------------------------------------------------------------
alter table food.orders
  add column reply_by timestamptz,
  add column nudged_at timestamptz,
  add column last_call_at timestamptz,
  add column refunded_pence integer not null default 0 check (refunded_pence >= 0);

-- Orders for later get longer (up to 12 hours, and at least 2 hours before
-- the time they're for), so a cook isn't rushed at night for tomorrow's food.
create function food.set_reply_by() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_minutes integer := coalesce((select reply_minutes from food.platform_settings where id = 1), 60);
  v_quick timestamptz := now() + make_interval(mins => v_minutes);
begin
  if new.status = 'pending_acceptance' and (tg_op = 'INSERT' or old.status is distinct from 'pending_acceptance') then
    if new.requested_for is null or new.requested_for <= now() + interval '3 hours' then
      new.reply_by := v_quick;
    else
      new.reply_by := greatest(v_quick, least(now() + interval '12 hours', new.requested_for - interval '2 hours'));
    end if;
    new.nudged_at := null;
    new.last_call_at := null;
  end if;
  return new;
end $$;
create trigger orders_reply_by before insert or update of status on food.orders
  for each row execute function food.set_reply_by();

-- Orders already waiting get the new deadline from now.
update food.orders set reply_by = now() + interval '60 minutes'
 where status = 'pending_acceptance' and reply_by is null;

create function food.london_clock(p timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p at time zone 'Europe/London', 'HH24:MI')
$$;

create or replace function food.expire_stale_orders() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update food.orders set status = 'expired'
   where status = 'awaiting_payment' and created_at < now() - interval '2 hours';
  update food.orders o
     set status = 'expired',
         decline_reason = 'The cook didn''t reply in time, so your order was cancelled. You won''t be charged for it.'
    from food.shop_settings s
   where o.status = 'pending_acceptance' and s.shop_id = o.shop_id
     and coalesce(o.reply_by, coalesce(o.paid_at, o.created_at) + make_interval(mins => s.acceptance_window_minutes)) < now();
  delete from food.notifications where created_at < now() - interval '90 days';
  delete from food.order_messages where created_at < now() - interval '180 days';
  delete from food.shop_chat_messages where created_at < now() - interval '180 days';
  delete from food.shop_chats c where c.last_message_at < now() - interval '180 days';
end $$;

-- Nudges for cooks: one after 15 minutes, and a last call 15 minutes before
-- the deadline when there's still time for one.
create function food.order_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer := 0;
  c integer;
begin
  with due as (
    update food.orders o set nudged_at = now()
     where o.status = 'pending_acceptance' and o.nudged_at is null and o.reply_by > now()
       and coalesce(o.paid_at, o.created_at) < now() - interval '15 minutes'
    returning o.shop_id, o.code, o.reply_by
  )
  insert into food.notifications (user_id, title, body, link)
  select food.shop_owner(d.shop_id), 'Order ' || d.code || ' is waiting for you',
         'Accept or decline it by ' || food.london_clock(d.reply_by) || ', or it’s cancelled automatically.', '/sell/orders'
    from due d where food.shop_owner(d.shop_id) is not null;
  get diagnostics c = row_count;
  n := n + c;

  with due as (
    update food.orders o set last_call_at = now()
     where o.status = 'pending_acceptance' and o.last_call_at is null and o.nudged_at is not null
       and o.reply_by > now() and o.reply_by < now() + interval '15 minutes'
       and o.nudged_at < now() - interval '10 minutes'
    returning o.shop_id, o.code, o.reply_by
  )
  insert into food.notifications (user_id, title, body, link)
  select food.shop_owner(d.shop_id), 'Last call: order ' || d.code,
         'It’s cancelled at ' || food.london_clock(d.reply_by) || ' unless you accept it.', '/sell/orders'
    from due d where food.shop_owner(d.shop_id) is not null;
  get diagnostics c = row_count;
  return n + c;
end $$;
revoke execute on function food.order_reminders() from public, anon, authenticated;

-- Cook's alert when an order runs out of time says why.
create or replace function food.notify_order_change() returns trigger
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
              new.customer_name || ' · ' || new.fulfilment || ' · £' || to_char(new.total_pence / 100.0, 'FM999990.00')
              || coalesce(' · reply by ' || food.london_clock(new.reply_by), ''),
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
        values (new.customer_id, 'Order ' || new.code || ' was cancelled',
                coalesce(new.decline_reason, 'The cook didn''t respond in time.'), v_link);
        insert into food.notifications (user_id, title, body, link)
        values (food.shop_owner(new.shop_id), 'Order ' || new.code || ' was cancelled',
                case when new.status = 'expired' and old.status = 'pending_acceptance'
                     then 'You didn’t accept it in time, so the customer wasn’t charged. Turn off “Open for orders” when you can’t reply quickly.'
                end, '/sell/orders');
      end if;
    else
      null;
  end case;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Phone notifications (web push)
-- ---------------------------------------------------------------------------
-- The key pair is made once by the deploy job (scripts/push-keys.mjs) and kept
-- in the private ops schema, which the app's API can never read.
create schema if not exists ops;
revoke all on schema ops from public;
create table if not exists ops.push_keys (
  id smallint primary key default 1 check (id = 1),
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
revoke all on ops.push_keys from public;

create function food.push_public_key() returns text
language sql stable security definer set search_path = '' as $$
  select public_key from ops.push_keys where id = 1
$$;
revoke execute on function food.push_public_key() from public;
grant execute on function food.push_public_key() to anon, authenticated;

create table food.push_subscriptions (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null unique check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  p256dh text not null check (char_length(p256dh) <= 200),
  auth text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);
create index on food.push_subscriptions (user_id);
alter table food.push_subscriptions enable row level security;
grant select (id, endpoint, created_at) on food.push_subscriptions to authenticated;
create policy "push subscriptions: own" on food.push_subscriptions
  for select to authenticated using (user_id = auth.uid());

create function food.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  insert into food.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (v_user, p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = v_user, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
  -- Ten phones or browsers each is plenty.
  delete from food.push_subscriptions
   where user_id = v_user and id not in (
     select id from food.push_subscriptions where user_id = v_user order by created_at desc limit 10);
end $$;
revoke execute on function food.save_push_subscription(text, text, text) from public, anon;
grant execute on function food.save_push_subscription(text, text, text) to authenticated;

create function food.remove_push_subscription(p_endpoint text) returns void
language sql security definer set search_path = '' as $$
  delete from food.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid()
$$;
revoke execute on function food.remove_push_subscription(text) from public, anon;
grant execute on function food.remove_push_subscription(text) to authenticated;

-- The sender reports phones that have unsubscribed. Endpoints are long
-- random addresses, so only the sender (or the phone itself) knows them.
create function food.forget_push_endpoints(p_endpoints text[]) returns void
language sql security definer set search_path = '' as $$
  delete from food.push_subscriptions where endpoint = any (p_endpoints[1:100])
$$;
revoke execute on function food.forget_push_endpoints(text[]) from public;
grant execute on function food.forget_push_endpoints(text[]) to anon, authenticated;

do $$
begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net not available, phone notifications are off: %', sqlerrm;
end $$;

-- Every alert is also sent to the person's phones. The request goes to the
-- app's own sender (netlify/functions/push.mts), which checks the key before
-- sending anything. A failure here never stops the alert itself.
create function food.push_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_subs jsonb;
  v_key text;
  v_url text;
begin
  select jsonb_agg(jsonb_build_object('endpoint', endpoint, 'p256dh', p256dh, 'auth', auth))
    into v_subs from food.push_subscriptions where user_id = new.user_id;
  if v_subs is null then return null; end if;
  select private_key into v_key from ops.push_keys where id = 1;
  if v_key is null then return null; end if;
  select site_url || '/.netlify/functions/push' into v_url from food.platform_settings where id = 1;
  begin
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      using v_url,
            jsonb_build_object('key', v_key, 'subs', v_subs, 'title', new.title, 'body', new.body,
                               'link', coalesce(new.link, '/alerts'), 'tag', new.id::text),
            '{"Content-Type": "application/json"}'::jsonb;
  exception when others then
    null;
  end;
  return null;
end $$;
create trigger notifications_push after insert on food.notifications
  for each row execute function food.push_alert();

-- ---------------------------------------------------------------------------
-- 2. Problem with my order
-- ---------------------------------------------------------------------------
create table food.order_issues (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references food.orders (id) on delete cascade,
  customer_id uuid not null references auth.users (id) on delete cascade,
  shop_id uuid not null references food.shops (id) on delete cascade,
  reason text not null check (reason in ('missing', 'wrong', 'quality', 'late_cold', 'not_received', 'allergy', 'other')),
  details text check (char_length(details) <= 1000),
  photo_path text check (char_length(photo_path) <= 200),
  status text not null default 'open' check (status in ('open', 'with_biteby', 'refunded', 'resolved')),
  cook_reply text check (char_length(cook_reply) <= 500),
  cook_replied_at timestamptz,
  refund_pence integer not null default 0 check (refund_pence >= 0),
  refunded_by text check (refunded_by in ('cook', 'biteby')),
  biteby_note text check (char_length(biteby_note) <= 500),
  escalated_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index on food.order_issues (shop_id, created_at desc);
create index on food.order_issues (status) where status in ('open', 'with_biteby');
alter table food.order_issues enable row level security;
grant select on food.order_issues to authenticated;
create policy "order issues: customer, cook or admin" on food.order_issues
  for select to authenticated
  using (customer_id = auth.uid() or food.owns_shop(shop_id) or food.is_admin());

create function food.issue_reason_label(p text) returns text
language sql immutable set search_path = '' as $$
  select case p
    when 'missing' then 'Something was missing'
    when 'wrong' then 'Wrong item'
    when 'quality' then 'Not as described'
    when 'late_cold' then 'Late or cold'
    when 'not_received' then 'Never got it'
    when 'allergy' then 'Allergy or food safety worry'
    else 'Something else' end
$$;

create function food.notify_admins(p_title text, p_body text, p_link text) returns void
language sql security definer set search_path = '' as $$
  insert into food.notifications (user_id, title, body, link)
  select a.user_id, left(p_title, 120), left(p_body, 300), p_link from food.app_admins a where a.revoked_at is null
$$;
revoke execute on function food.notify_admins(text, text, text) from public, anon, authenticated;

-- Most a refund can be: what the customer paid, less refunds already made.
create function food.refund_left(p_order uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(0, total_pence - refunded_pence) from food.orders where id = p_order
$$;
revoke execute on function food.refund_left(uuid) from public, anon, authenticated;

create function food.report_order_issue(p_order uuid, p_reason text, p_details text default null, p_photo text default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  o food.orders;
  v_id uuid;
  v_status text := case when p_reason = 'allergy' then 'with_biteby' else 'open' end;
  v_details text := nullif(trim(food.redact_contact(coalesce(p_details, ''))), '');
begin
  select * into o from food.orders where id = p_order and customer_id = auth.uid();
  if not found then raise exception 'Order not found'; end if;
  if o.status not in ('accepted', 'ready', 'out_for_delivery', 'completed') then
    raise exception 'You can report a problem once the cook has accepted your order.';
  end if;
  if o.status = 'completed' and coalesce(o.completed_at, o.updated_at) < now() - interval '48 hours' then
    raise exception 'Problems need reporting within 48 hours. Use Help if you still need us.';
  end if;
  if exists (select 1 from food.order_issues where order_id = p_order) then
    raise exception 'You''ve already reported a problem with this order.';
  end if;
  if p_photo is not null and (p_photo not like auth.uid()::text || '/%' or p_photo like '%..%') then
    raise exception 'That photo can''t be used';
  end if;
  if p_reason in ('other', 'quality') and v_details is null then
    raise exception 'Tell the cook a little about what went wrong.';
  end if;
  insert into food.order_issues (order_id, customer_id, shop_id, reason, details, photo_path, status, escalated_at)
  values (p_order, auth.uid(), o.shop_id, p_reason, left(v_details, 1000), p_photo, v_status,
          case when v_status = 'with_biteby' then now() end)
  returning id into v_id;
  insert into food.notifications (user_id, title, body, link)
  select food.shop_owner(o.shop_id), 'Problem with order ' || o.code,
         food.issue_reason_label(p_reason) || coalesce(': ' || left(v_details, 200), ''), '/sell/orders?open=' || o.id
   where food.shop_owner(o.shop_id) is not null;
  if v_status = 'with_biteby' then
    perform food.notify_admins('Allergy or safety worry: order ' || o.code, coalesce(v_details, 'No details given'), '/admin?tab=problems');
  end if;
  return v_id;
end $$;
revoke execute on function food.report_order_issue(uuid, text, text, text) from public, anon;
grant execute on function food.report_order_issue(uuid, text, text, text) to authenticated;

-- Recording a refund. The money itself moves with Stripe when payments go
-- live: the cook's payout is reduced and the customer's card refunded.
create function food.apply_issue_refund(p_issue uuid, p_pence integer, p_by text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i food.order_issues;
  v_code text;
  v_shop text;
begin
  select * into i from food.order_issues where id = p_issue for update;
  if p_pence < 1 or p_pence > food.refund_left(i.order_id) then
    raise exception 'The refund can be up to %', '£' || to_char(food.refund_left(i.order_id) / 100.0, 'FM999990.00');
  end if;
  update food.orders set refunded_pence = refunded_pence + p_pence where id = i.order_id returning code into v_code;
  update food.order_issues
     set status = 'refunded', refund_pence = refund_pence + p_pence, refunded_by = p_by, resolved_at = now()
   where id = p_issue;
  select name into v_shop from food.shops where id = i.shop_id;
  insert into food.notifications (user_id, title, body, link)
  values (i.customer_id, '£' || to_char(p_pence / 100.0, 'FM999990.00') || ' refund for order ' || v_code,
          case when p_by = 'cook' then v_shop || ' sent you a refund.' else 'The BiteBY team sent you a refund.' end
          || ' It goes back to your card within 5 to 10 working days.', '/orders/' || i.order_id);
end $$;
revoke execute on function food.apply_issue_refund(uuid, integer, text) from public, anon, authenticated;

-- The cook answers: refund some or all of it, or reply with a message.
create function food.cook_answer_issue(p_issue uuid, p_refund_pence integer default 0, p_reply text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i food.order_issues;
  v_reply text := nullif(trim(food.redact_contact(coalesce(p_reply, ''))), '');
  v_code text;
begin
  select * into i from food.order_issues where id = p_issue for update;
  if not found or not food.owns_shop(i.shop_id) then raise exception 'Problem not found'; end if;
  if i.status not in ('open', 'with_biteby') then raise exception 'This problem is already sorted.'; end if;
  if coalesce(p_refund_pence, 0) = 0 and v_reply is null then raise exception 'Write a reply or choose a refund.'; end if;
  update food.order_issues set cook_reply = coalesce(left(v_reply, 500), cook_reply), cook_replied_at = now() where id = p_issue;
  if coalesce(p_refund_pence, 0) > 0 then
    perform food.apply_issue_refund(p_issue, p_refund_pence, 'cook');
  else
    select code into v_code from food.orders where id = i.order_id;
    insert into food.notifications (user_id, title, body, link)
    values (i.customer_id, 'The cook replied about order ' || v_code, left(v_reply, 300), '/orders/' || i.order_id || '#problem');
  end if;
end $$;
revoke execute on function food.cook_answer_issue(uuid, integer, text) from public, anon;
grant execute on function food.cook_answer_issue(uuid, integer, text) to authenticated;

-- The customer says it's sorted, or asks BiteBY to step in.
create function food.customer_issue_action(p_issue uuid, p_action text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i food.order_issues;
  v_code text;
begin
  select * into i from food.order_issues where id = p_issue and customer_id = auth.uid() for update;
  if not found then raise exception 'Problem not found'; end if;
  select code into v_code from food.orders where id = i.order_id;
  if p_action = 'sorted' and i.status in ('open', 'with_biteby') then
    update food.order_issues set status = 'resolved', resolved_at = now() where id = p_issue;
  elsif p_action = 'escalate' and i.status = 'open' then
    update food.order_issues set status = 'with_biteby', escalated_at = now() where id = p_issue;
    perform food.notify_admins('Customer needs help: order ' || v_code, food.issue_reason_label(i.reason), '/admin?tab=problems');
  else
    raise exception 'That can''t be done now.';
  end if;
end $$;
revoke execute on function food.customer_issue_action(uuid, text) from public, anon;
grant execute on function food.customer_issue_action(uuid, text) to authenticated;

create function food.admin_answer_issue(p_issue uuid, p_refund_pence integer default 0, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i food.order_issues;
  v_code text;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  select * into i from food.order_issues where id = p_issue for update;
  if not found then raise exception 'Problem not found'; end if;
  update food.order_issues set biteby_note = coalesce(left(nullif(trim(p_note), ''), 500), biteby_note) where id = p_issue;
  if coalesce(p_refund_pence, 0) > 0 then
    perform food.apply_issue_refund(p_issue, p_refund_pence, 'biteby');
  else
    update food.order_issues set status = 'resolved', resolved_at = now() where id = p_issue;
    select code into v_code from food.orders where id = i.order_id;
    insert into food.notifications (user_id, title, body, link)
    values (i.customer_id, 'BiteBY replied about order ' || v_code, left(coalesce(nullif(trim(p_note), ''), 'We’ve looked into it.'), 300), '/orders/' || i.order_id || '#problem');
  end if;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id)
  values (auth.uid(), 'admin', 'order_issue_answered', 'food.order_issues', p_issue::text);
end $$;
revoke execute on function food.admin_answer_issue(uuid, integer, text) from public, anon;
grant execute on function food.admin_answer_issue(uuid, integer, text) to authenticated;

-- Cooks get 24 hours to answer before BiteBY steps in.
create function food.escalate_old_issues() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    update food.order_issues i set status = 'with_biteby', escalated_at = now()
     where i.status = 'open' and i.cook_replied_at is null and i.created_at < now() - interval '24 hours'
    returning i.order_id
  loop
    perform food.notify_admins('Cook didn’t answer a problem: order ' || (select code from food.orders where id = r.order_id),
                               'No reply after 24 hours.', '/admin?tab=problems');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function food.escalate_old_issues() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bug alerts
-- ---------------------------------------------------------------------------
create table food.client_errors (
  id bigint generated always as identity primary key,
  fingerprint text not null unique,
  message text not null,
  stack text,
  page text,
  user_agent text,
  app_version text,
  last_user_id uuid,
  users_seen integer not null default 1,
  times integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
alter table food.client_errors enable row level security;
grant select on food.client_errors to authenticated;
create policy "client errors: admins" on food.client_errors for select to authenticated using (food.is_admin());

-- Called by the app when something breaks. Repeats of the same error just
-- add to its count, and the table never holds more than 300 kinds.
create function food.log_client_error(p_message text, p_stack text default null, p_page text default null,
                                      p_agent text default null, p_version text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_message text := left(coalesce(nullif(trim(p_message), ''), 'Unknown error'), 300);
  v_stack text := left(p_stack, 2000);
  v_fp text;
  v_new integer;
begin
  v_fp := md5(v_message || '|' || coalesce(regexp_replace(split_part(coalesce(v_stack, ''), E'\n', 2), '[?:][^/]*$', ''), ''));
  if (select count(*) from food.client_errors where last_seen > now() - interval '1 minute') > 30 then return; end if;
  update food.client_errors
     set times = times + 1, last_seen = now(), page = left(p_page, 200), user_agent = left(p_agent, 200),
         app_version = left(p_version, 40),
         users_seen = users_seen + case when auth.uid() is distinct from last_user_id then 1 else 0 end,
         last_user_id = coalesce(auth.uid(), last_user_id)
   where fingerprint = v_fp;
  if found then return; end if;
  delete from food.client_errors where last_seen < now() - interval '30 days';
  if (select count(*) from food.client_errors) >= 300 then return; end if;
  insert into food.client_errors (fingerprint, message, stack, page, user_agent, app_version, last_user_id)
  values (v_fp, v_message, v_stack, left(p_page, 200), left(p_agent, 200), left(p_version, 40), auth.uid())
  on conflict (fingerprint) do nothing;
  get diagnostics v_new = row_count;
  -- At most one "new error" alert an hour, so a bad release doesn't flood the phone.
  if v_new > 0 and not exists (select 1 from food.client_errors where fingerprint <> v_fp and first_seen > now() - interval '1 hour') then
    perform food.notify_admins('New app error', v_message, '/admin?tab=bugs');
  end if;
end $$;
revoke execute on function food.log_client_error(text, text, text, text, text) from public;
grant execute on function food.log_client_error(text, text, text, text, text) to anon, authenticated;

create function food.admin_clear_errors(p_id bigint default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  delete from food.client_errors where p_id is null or id = p_id;
end $$;
revoke execute on function food.admin_clear_errors(bigint) from public, anon;
grant execute on function food.admin_clear_errors(bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Town pages
-- ---------------------------------------------------------------------------
-- The town is the first part of a shop's area label ("Bow, E3" -> Bow).
create function food.town_slug(p text) returns text
language sql immutable set search_path = '' as $$
  select trim(both '-' from regexp_replace(lower(trim(split_part(coalesce(p, ''), ',', 1))), '[^a-z0-9]+', '-', 'g'))
$$;

create function food.towns() returns table (slug text, town text, shops int, real_shops int)
language sql stable security definer set search_path = '' as $$
  select food.town_slug(s.area_label), min(trim(split_part(s.area_label, ',', 1))),
         count(*)::int, count(*) filter (where not s.is_demo)::int
    from food.shops s
   where food.shop_is_public(s.id) and not s.is_test and food.town_slug(s.area_label) <> ''
   group by 1
   order by 3 desc, 2
   limit 200
$$;
revoke execute on function food.towns() from public;
grant execute on function food.towns() to anon, authenticated;

create function food.town_shop_ids(p_slug text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.id from food.shops s
   where food.town_slug(s.area_label) = p_slug and food.shop_is_public(s.id) and not s.is_test
   limit 100
$$;
revoke execute on function food.town_shop_ids(text) from public;
grant execute on function food.town_shop_ids(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Reorder nudges and updates for regulars
-- ---------------------------------------------------------------------------
create table food.reorder_nudges (
  user_id uuid not null references auth.users (id) on delete cascade,
  shop_id uuid not null references food.shops (id) on delete cascade,
  sent_at timestamptz not null default now(),
  primary key (user_id, shop_id)
);
alter table food.reorder_nudges enable row level security;

-- Two weeks after someone's last order from a cook (and not more than once a
-- month per cook), a friendly "fancy it again?" naming a dish they had.
-- Only sent in the daytime.
create function food.send_reorder_nudges() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_hour int := extract(hour from now() at time zone 'Europe/London');
  n integer;
begin
  if v_hour < 10 or v_hour >= 19 then return 0; end if;
  with last_orders as (
    select distinct on (o.customer_id, o.shop_id) o.id, o.customer_id, o.shop_id, o.completed_at
      from food.orders o
     where o.status = 'completed'
     order by o.customer_id, o.shop_id, o.completed_at desc
  ), due as (
    select l.*, s.name as shop_name, s.slug,
           (select i.name from food.order_items i join food.products p on p.id = i.product_id and p.status = 'published'
             where i.order_id = l.id order by i.line_total_pence desc limit 1) as dish
      from last_orders l
      join food.shops s on s.id = l.shop_id and s.accepting_orders
      join food.profiles pr on pr.id = l.customer_id and pr.cook_updates
     where l.completed_at between now() - interval '60 days' and now() - interval '14 days'
       and food.shop_is_public(l.shop_id)
       and not exists (select 1 from food.orders x where x.customer_id = l.customer_id and x.shop_id = l.shop_id
                        and x.created_at > l.completed_at and x.status not in ('expired', 'cancelled', 'declined'))
       and not exists (select 1 from food.reorder_nudges r where r.user_id = l.customer_id and r.shop_id = l.shop_id
                        and r.sent_at > now() - interval '30 days')
     limit 200
  ), logged as (
    insert into food.reorder_nudges (user_id, shop_id)
    select customer_id, shop_id from due
    on conflict (user_id, shop_id) do update set sent_at = now()
    returning user_id
  )
  insert into food.notifications (user_id, title, body, link)
  select d.customer_id, left('Fancy ' || d.shop_name || ' again?', 120),
         left(case when d.dish is not null then 'Your ' || d.dish || ' is still on the menu. Order again in a couple of taps.'
                   else 'See what''s cooking this week.' end, 300),
         '/s/' || d.slug
    from due d;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function food.send_reorder_nudges() from public, anon, authenticated;

create table food.regulars_updates (
  id bigint generated always as identity primary key,
  shop_id uuid not null references food.shops (id) on delete cascade,
  body text not null check (char_length(body) between 5 and 140),
  product_id uuid references food.products (id) on delete set null,
  sent_to integer not null default 0,
  created_at timestamptz not null default now()
);
create index on food.regulars_updates (shop_id, created_at desc);
alter table food.regulars_updates enable row level security;
grant select on food.regulars_updates to authenticated;
create policy "regulars updates: shop owner or admin" on food.regulars_updates
  for select to authenticated using (food.owns_shop(shop_id) or food.is_admin());

-- Who hears a cook's update: people who ordered in the last 6 months, plus
-- followers, who haven't turned cook updates off.
create function food.shop_regulars(p_shop uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select u.id from (
    select o.customer_id as id from food.orders o
     where o.shop_id = p_shop and o.paid_at is not null and o.created_at > now() - interval '180 days'
       and o.status not in ('declined', 'cancelled', 'expired', 'refunded')
    union
    select f.user_id from food.favourites f where f.shop_id = p_shop
  ) u
  join food.profiles pr on pr.id = u.id and pr.cook_updates
  where u.id is distinct from food.shop_owner(p_shop)
$$;
revoke execute on function food.shop_regulars(uuid) from public, anon, authenticated;

create function food.my_regulars() returns json
language plpgsql stable security definer set search_path = '' as $$
declare
  v_shop uuid;
  v_last timestamptz;
begin
  select s.id into v_shop from food.shops s join food.seller_accounts a on a.id = s.seller_account_id
   where a.user_id = auth.uid() order by s.created_at limit 1;
  if v_shop is null then return null; end if;
  select max(created_at) into v_last from food.regulars_updates where shop_id = v_shop;
  return json_build_object('count', (select count(*) from food.shop_regulars(v_shop)),
                           'last_sent', v_last,
                           'next_allowed', case when v_last > now() - interval '7 days' then v_last + interval '7 days' end);
end $$;
revoke execute on function food.my_regulars() from public, anon;
grant execute on function food.my_regulars() to authenticated;

create function food.send_regulars_update(p_body text, p_product uuid default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_shop food.shops;
  v_body text := trim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g'));
  v_reason text;
  v_link text;
  n integer;
begin
  select s.* into v_shop from food.shops s join food.seller_accounts a on a.id = s.seller_account_id
   where a.user_id = auth.uid() order by s.created_at limit 1;
  if not found then raise exception 'Shop not found'; end if;
  if not food.shop_is_public(v_shop.id) then raise exception 'Your shop needs to be live to send updates.'; end if;
  if char_length(v_body) < 5 or char_length(v_body) > 140 then raise exception 'Keep it between 5 and 140 characters.'; end if;
  v_reason := food.off_app_reason(v_body);
  if v_reason is not null then
    raise exception 'Please take out % from your update. Customers order and pay through BiteBY.', v_reason;
  end if;
  if exists (select 1 from food.regulars_updates where shop_id = v_shop.id and created_at > now() - interval '7 days') then
    raise exception 'You can send one update a week, so customers keep looking forward to them.';
  end if;
  if p_product is not null and not exists (select 1 from food.products where id = p_product and shop_id = v_shop.id and status = 'published') then
    raise exception 'Choose a dish from your menu';
  end if;
  v_link := '/s/' || v_shop.slug || coalesce('/i/' || p_product, '');
  insert into food.notifications (user_id, title, body, link)
  select r, left(v_shop.name, 120), v_body, v_link from food.shop_regulars(v_shop.id) r;
  get diagnostics n = row_count;
  insert into food.regulars_updates (shop_id, body, product_id, sent_to) values (v_shop.id, v_body, p_product, n);
  return n;
end $$;
revoke execute on function food.send_regulars_update(text, uuid) from public, anon;
grant execute on function food.send_regulars_update(text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The job runner
-- ---------------------------------------------------------------------------
create table food.job_runs (
  id smallint primary key default 1 check (id = 1),
  last_run timestamptz,
  last_source text,
  last_hourly timestamptz,
  runs_today integer not null default 0,
  sources jsonb not null default '{}'
);
insert into food.job_runs (id) values (1);
alter table food.job_runs enable row level security;
grant select on food.job_runs to authenticated;
create policy "job runs: admins" on food.job_runs for select to authenticated using (food.is_admin());

-- Safe for anyone to call: it runs at most once every 50 seconds and only
-- does the timed jobs above.
create function food.run_jobs(p_source text default 'app') returns text
language plpgsql security definer set search_path = '' as $$
declare
  j food.job_runs;
  v_source text := case when p_source in ('cron', 'netlify', 'app', 'github') then p_source else 'app' end;
begin
  select * into j from food.job_runs where id = 1 for update skip locked;
  if not found or j.last_run > now() - interval '50 seconds' then return 'skipped'; end if;
  update food.job_runs
     set last_run = now(), last_source = v_source,
         sources = sources || jsonb_build_object(v_source, now())
   where id = 1;
  perform food.expire_stale_orders();
  perform food.order_reminders();
  perform food.escalate_old_issues();
  if j.last_hourly is null or j.last_hourly < now() - interval '1 hour' then
    update food.job_runs set last_hourly = now() where id = 1;
    perform food.send_reorder_nudges();
    perform food.insurance_reminders();
    perform food.tax_details_reminders();
  end if;
  return 'ran';
end $$;
revoke execute on function food.run_jobs(text) from public;
grant execute on function food.run_jobs(text) to anon, authenticated;

do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname in ('biteby-reminders', 'biteby-jobs');
  perform cron.schedule('biteby-jobs', '* * * * *', 'select food.run_jobs(''cron'')');
exception when others then
  raise notice 'pg_cron not available, jobs run from the Netlify timer and the app: %', sqlerrm;
end $$;

