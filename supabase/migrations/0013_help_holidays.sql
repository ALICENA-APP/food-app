-- Help requests: customers and sellers can report a problem with an order or
-- contact the BiteBY team. Admins answer from the admin page.
create table food.help_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete set null,
  order_id uuid references food.orders (id) on delete set null,
  topic text not null check (topic in ('missing', 'wrong', 'quality', 'late', 'allergy', 'payment', 'account', 'selling', 'other')),
  details text not null check (char_length(details) between 5 and 1000),
  status text not null default 'open' check (status in ('open', 'resolved')),
  admin_reply text check (char_length(admin_reply) <= 1000),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index on food.help_requests (user_id, created_at desc);
create index on food.help_requests (status, created_at desc);
alter table food.help_requests enable row level security;
grant select on food.help_requests to authenticated;
create policy "help requests: own or admin" on food.help_requests
  for select to authenticated using (user_id = auth.uid() or food.is_admin());

create function food.ask_for_help(p_topic text, p_details text, p_order uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_details text := btrim(p_details);
  v_code text;
  v_id uuid;
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  if char_length(v_details) < 5 then raise exception 'Tell us a little more about what happened'; end if;
  if p_order is not null then
    select code into v_code from food.orders o
     where o.id = p_order and (o.customer_id = v_user or food.owns_shop(o.shop_id));
    if v_code is null then raise exception 'Order not found'; end if;
  end if;
  if (select count(*) from food.help_requests where user_id = v_user and created_at > now() - interval '1 day') >= 5 then
    raise exception 'You''ve sent a few requests today. We''ll reply to those first.';
  end if;
  insert into food.help_requests (user_id, order_id, topic, details)
  values (v_user, p_order, p_topic, left(v_details, 1000))
  returning id into v_id;

  insert into food.notifications (user_id, title, body, link)
  select a.user_id, 'Help request' || coalesce(' · ' || v_code, ''), left(v_details, 300), '/admin?tab=help'
    from food.app_admins a where a.revoked_at is null;
  return v_id;
end $$;
revoke execute on function food.ask_for_help(text, text, uuid) from public, anon;
grant execute on function food.ask_for_help(text, text, uuid) to authenticated;

-- Admin inbox: requests with who sent them and which order.
create function food.admin_help_requests(p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
      select h.id, h.topic, h.details, h.status, h.admin_reply, h.created_at, h.resolved_at,
             u.email, p.display_name as name,
             o.id as order_id, o.code as order_code, o.status as order_status, o.total_pence, s.name as shop_name,
             exists (select 1 from food.seller_accounts sa where sa.user_id = h.user_id) as is_seller
        from food.help_requests h
        left join auth.users u on u.id = h.user_id
        left join food.profiles p on p.id = h.user_id
        left join food.orders o on o.id = h.order_id
        left join food.shops s on s.id = o.shop_id
       where h.status = p_status
       order by h.created_at desc
       limit 100
    ) x), '[]'::jsonb);
end $$;
revoke execute on function food.admin_help_requests(text) from public, anon;
grant execute on function food.admin_help_requests(text) to authenticated;

create function food.admin_answer_help(p_id uuid, p_reply text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  h food.help_requests;
  v_reply text := btrim(p_reply);
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if char_length(v_reply) = 0 then raise exception 'Write a reply first'; end if;
  update food.help_requests
     set status = 'resolved', admin_reply = left(v_reply, 1000), resolved_at = now()
   where id = p_id
   returning * into h;
  if not found then raise exception 'Request not found'; end if;
  if h.user_id is not null then
    insert into food.notifications (user_id, title, body, link)
    values (h.user_id, 'The BiteBY team replied', left(v_reply, 300), '/help/requests');
  end if;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'help_answered', 'help_requests', p_id::text, jsonb_build_object('reply', left(v_reply, 1000)));
end $$;
revoke execute on function food.admin_answer_help(uuid, text) from public, anon;
grant execute on function food.admin_answer_help(uuid, text) to authenticated;

-- The overview counts open help requests too.
create or replace function food.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return jsonb_build_object(
    'users', (select count(*) from auth.users),
    'new_users_7d', (select count(*) from auth.users where created_at > now() - interval '7 days'),
    'sellers', (select coalesce(jsonb_object_agg(status, n), '{}') from (select status, count(*) n from food.seller_accounts group by status) s),
    'live_shops', (select count(*) from food.shops where status = 'live'),
    'dishes_on_sale', (select count(*) from food.products where status = 'published'),
    'orders_7d', (select count(*) from food.orders where created_at > now() - interval '7 days' and paid_at is not null),
    'orders_30d', (select count(*) from food.orders where created_at > now() - interval '30 days' and paid_at is not null),
    'sales_30d_pence', (select coalesce(sum(total_pence), 0) from food.orders where created_at > now() - interval '30 days' and status = 'completed'),
    'fees_30d_pence', (select coalesce(sum(platform_fee_pence), 0) from food.orders where created_at > now() - interval '30 days' and status = 'completed'),
    'open_orders', (select count(*) from food.orders where status in ('pending_acceptance', 'accepted', 'ready', 'out_for_delivery')),
    'reviews_30d', (select count(*) from food.reviews where created_at > now() - interval '30 days'),
    'deletion_requests', (select count(*) from food.account_deletions where done_at is null),
    'open_help', (select count(*) from food.help_requests where status = 'open')
  );
end $$;

-- Days off are respected when ordering: no orders for a day the cook is away.
create function food.check_shop_closure() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (coalesce(new.requested_for, now()) at time zone 'Europe/London')::date;
begin
  if exists (select 1 from food.shop_closures where shop_id = new.shop_id and closed_on = v_day) then
    raise exception 'The cook is away on %. Please choose another day.', to_char(v_day, 'FMDay FMDD FMMonth');
  end if;
  return new;
end $$;
create trigger orders_check_closure before insert on food.orders
  for each row execute function food.check_shop_closure();
