-- Invite a cook: every cook has an invite code. When a cook they invited has
-- 5 paid orders, both get 30 more days with no BiteBY fee (added after any
-- free time they already have). No cash changes hands, and fake sign-ups
-- earn nothing because the reward needs real paid orders.
-- Limits so it can't snowball: a new cook gets at most one invite month, and
-- an inviter earns at most 3 free months in total (their invites still count
-- for the new cooks after that).

alter table food.platform_settings
  add column if not exists invite_free_days integer not null default 30 check (invite_free_days between 0 and 365),
  add column if not exists invite_orders_needed integer not null default 5 check (invite_orders_needed between 1 and 100),
  add column if not exists invite_max_rewards integer not null default 3 check (invite_max_rewards between 0 and 100);

alter table food.seller_accounts
  add column if not exists invite_code text unique,
  add column if not exists referred_by uuid references food.seller_accounts (id) on delete set null,
  add column if not exists invite_rewarded_at timestamptz;

-- Short, easy-to-type codes without look-alike letters.
create or replace function food.new_invite_code() returns text
language plpgsql volatile set search_path = '' as $$
declare
  v text;
begin
  loop
    select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1), '') into v
      from generate_series(1, 6);
    exit when not exists (select 1 from food.seller_accounts where invite_code = v);
  end loop;
  return v;
end $$;

update food.seller_accounts set invite_code = food.new_invite_code() where invite_code is null;
alter table food.seller_accounts alter column invite_code set default food.new_invite_code();

-- Extra time with no BiteBY fee (from invites, or given by the team).
create table if not exists food.fee_free_periods (
  id bigint generated always as identity primary key,
  seller_account_id uuid not null references food.seller_accounts (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null check (char_length(reason) <= 120),
  created_at timestamptz not null default now()
);
create index if not exists fee_free_periods_account on food.fee_free_periods (seller_account_id, ends_at);
alter table food.fee_free_periods enable row level security;
grant select on food.fee_free_periods to authenticated;
create policy "fee free periods: owner or admin" on food.fee_free_periods for select to authenticated
  using (food.is_admin() or exists (select 1 from food.seller_accounts a where a.id = seller_account_id and a.user_id = auth.uid()));

-- The end of all the shop's fee-free time that runs on from now (welcome
-- month and any extra free months back to back), or null if none.
create or replace function food.shop_free_until(p_shop uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select max(p.ends_at) from food.fee_free_periods p
    join food.shops s on s.seller_account_id = p.seller_account_id
   where s.id = p_shop and p.starts_at <= now() and p.ends_at > now()
$$;
revoke execute on function food.shop_free_until(uuid) from public;

create or replace function food.shop_commission_bps(p_shop uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case
           when food.shop_free_until(p_shop) is not null then 0
           when coalesce(food.shop_intro_ends(p_shop) > now(), true) and s.intro_days > 0
             then least(s.intro_commission_bps, s.commission_bps)
           else s.commission_bps end
    from food.platform_settings s where s.id = 1
$$;
revoke execute on function food.shop_commission_bps(uuid) from public;

-- Adds free days for a cook after all the free time they already have.
create or replace function food.grant_free_days(p_account uuid, p_days integer, p_reason text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := now();
  v_intro timestamptz;
  v_shop uuid;
begin
  select id into v_shop from food.shops where seller_account_id = p_account limit 1;
  if v_shop is not null then
    -- After the welcome month, if it's still running.
    v_intro := food.shop_intro_ends(v_shop);
    v_start := greatest(v_start, coalesce(v_intro, v_start));
  end if;
  v_start := greatest(v_start, coalesce((select max(ends_at) from food.fee_free_periods where seller_account_id = p_account), v_start));
  insert into food.fee_free_periods (seller_account_id, starts_at, ends_at, reason)
  values (p_account, v_start, v_start + make_interval(days => p_days), p_reason);
  return v_start + make_interval(days => p_days);
end $$;
revoke execute on function food.grant_free_days(uuid, integer, text) from public, anon, authenticated;

-- Who invited you: shown on the sign-up page from an invite link.
create or replace function food.invite_info(p_code text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('shop_name', coalesce(s.name, a.trading_name, 'A BiteBY cook'),
                            'free_days', (select invite_free_days from food.platform_settings where id = 1))
    from food.seller_accounts a
    left join food.shops s on s.seller_account_id = a.id
   where a.invite_code = upper(btrim(p_code)) and a.status = 'approved'
   limit 1
$$;
grant execute on function food.invite_info(text) to anon, authenticated;

-- A new cook enters (or arrives with) an invite code.
create or replace function food.use_invite_code(p_code text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me food.seller_accounts;
  v_from food.seller_accounts;
  v_shop text;
begin
  select * into me from food.seller_accounts where user_id = auth.uid();
  if not found then raise exception 'Start your application first'; end if;
  if me.referred_by is not null then raise exception 'You’ve already used an invite code'; end if;
  select * into v_from from food.seller_accounts where invite_code = upper(btrim(p_code)) and status = 'approved';
  if not found then raise exception 'That invite code isn’t right. Check it with the cook who invited you.'; end if;
  if v_from.id = me.id then raise exception 'You can’t use your own invite code'; end if;
  if v_from.referred_by = me.id then raise exception 'You invited this cook, so you can’t use their code'; end if;
  if exists (select 1 from food.orders o join food.shops s on s.id = o.shop_id
              where s.seller_account_id = me.id and o.status not in ('awaiting_payment', 'expired')) then
    raise exception 'Invite codes are for new cooks who haven’t sold yet';
  end if;
  update food.seller_accounts set referred_by = v_from.id where id = me.id;
  select name into v_shop from food.shops where seller_account_id = v_from.id limit 1;
  return coalesce(v_shop, v_from.trading_name, 'your friend');
end $$;
revoke execute on function food.use_invite_code(text) from public, anon;
grant execute on function food.use_invite_code(text) to authenticated;

-- Once an invited cook reaches the paid orders needed, both get free days.
create or replace function food.check_invite_reward() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a food.seller_accounts;
  s food.platform_settings;
  v_paid int;
  v_ends timestamptz;
  v_new_shop text;
begin
  if not (old.status = 'awaiting_payment' and new.status not in ('awaiting_payment', 'expired')) then return new; end if;
  select acc.* into a from food.seller_accounts acc join food.shops sh on sh.seller_account_id = acc.id where sh.id = new.shop_id;
  if a.referred_by is null or a.invite_rewarded_at is not null then return new; end if;
  select * into s from food.platform_settings where id = 1;
  select count(*) into v_paid from food.orders where shop_id = new.shop_id and status not in ('awaiting_payment', 'expired', 'declined', 'cancelled', 'refunded');
  if v_paid < s.invite_orders_needed or s.invite_free_days = 0 then return new; end if;

  update food.seller_accounts set invite_rewarded_at = now() where id = a.id;
  select name into v_new_shop from food.shops where seller_account_id = a.id limit 1;
  v_ends := food.grant_free_days(a.id, s.invite_free_days, 'Joined with an invite');
  insert into food.notifications (user_id, title, body, link)
  select a.user_id, 'You’ve earned a free month', format('Thanks for joining with an invite. You won’t pay any BiteBY fee until %s.', to_char(v_ends at time zone 'Europe/London', 'FMDD FMMonth')), '/sell'
   where a.user_id is not null;
  -- The inviter's free months are capped.
  if (select count(*) from food.seller_accounts x where x.referred_by = a.referred_by and x.invite_rewarded_at is not null and x.id <> a.id) >= s.invite_max_rewards then
    insert into food.notifications (user_id, title, body, link)
    select r.user_id, 'The cook you invited is up and running', format('%s now has %s paid orders. Thanks for inviting them! You’ve already earned the most free months invites can give.', coalesce(v_new_shop, 'The cook you invited'), s.invite_orders_needed), '/sell'
      from food.seller_accounts r where r.id = a.referred_by and r.user_id is not null;
    return new;
  end if;
  v_ends := food.grant_free_days(a.referred_by, s.invite_free_days, 'Invited ' || coalesce(v_new_shop, 'a cook'));
  insert into food.notifications (user_id, title, body, link)
  select r.user_id, 'Your invite paid off: free month', format('%s is up and running, so you won’t pay any BiteBY fee until %s. Thanks for inviting them!', coalesce(v_new_shop, 'The cook you invited'), to_char(v_ends at time zone 'Europe/London', 'FMDD FMMonth')), '/sell'
    from food.seller_accounts r where r.id = a.referred_by and r.user_id is not null;
  return new;
end $$;
drop trigger if exists orders_invite_reward on food.orders;
create trigger orders_invite_reward after update of status on food.orders
  for each row execute function food.check_invite_reward();

-- For the cook's dashboard: their code and the cooks they invited.
create or replace function food.my_invites() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  me food.seller_accounts;
  s food.platform_settings;
begin
  select * into me from food.seller_accounts where user_id = auth.uid();
  if not found then return null; end if;
  select * into s from food.platform_settings where id = 1;
  return jsonb_build_object(
    'code', me.invite_code,
    'can_invite', me.status = 'approved',
    'free_days', s.invite_free_days,
    'orders_needed', s.invite_orders_needed,
    'max_rewards', s.invite_max_rewards,
    'invited_by', (select coalesce(sh.name, r.trading_name, 'A BiteBY cook') from food.seller_accounts r left join food.shops sh on sh.seller_account_id = r.id where r.id = me.referred_by limit 1),
    'my_reward_at', me.invite_rewarded_at,
    'invited', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(sh.name, a.trading_name, 'New cook'),
               'status', a.status,
               'paid_orders', least(s.invite_orders_needed, (select count(*) from food.orders o where o.shop_id = sh.id
                                                              and o.status not in ('awaiting_payment', 'expired', 'declined', 'cancelled', 'refunded'))),
               'rewarded_at', a.invite_rewarded_at) order by a.created_at desc)
        from food.seller_accounts a left join food.shops sh on sh.seller_account_id = a.id
       where a.referred_by = me.id), '[]'::jsonb));
end $$;
revoke execute on function food.my_invites() from public, anon;
grant execute on function food.my_invites() to authenticated;

-- The cook's fee now also knows about extra free months.
create or replace function food.my_fee_rate(p_shop uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s food.platform_settings;
  v_ends timestamptz;
begin
  if not food.owns_shop(p_shop) then raise exception 'Not your shop'; end if;
  select * into s from food.platform_settings where id = 1;
  v_ends := food.shop_intro_ends(p_shop);
  return jsonb_build_object(
    'rate_bps', food.shop_commission_bps(p_shop),
    'standard_bps', s.commission_bps,
    'intro_bps', least(s.intro_commission_bps, s.commission_bps),
    'intro_days', s.intro_days,
    'intro_started', v_ends is not null,
    'intro_ends_at', v_ends,
    'free_until', (select max(p.ends_at) from food.fee_free_periods p join food.shops sh on sh.seller_account_id = p.seller_account_id
                    where sh.id = p_shop and p.ends_at > now()));
end $$;

-- Admin: who invited whom.
create or replace function food.admin_invites() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cook', coalesce(sh.name, a.trading_name, a.legal_name),
             'invited_by', coalesce(rs.name, r.trading_name, r.legal_name),
             'status', a.status,
             'paid_orders', (select count(*) from food.orders o where o.shop_id = sh.id
                              and o.status not in ('awaiting_payment', 'expired', 'declined', 'cancelled', 'refunded')),
             'rewarded_at', a.invite_rewarded_at,
             'demo', a.is_demo) order by a.created_at desc)
      from food.seller_accounts a
      join food.seller_accounts r on r.id = a.referred_by
      left join food.shops sh on sh.seller_account_id = a.id
      left join food.shops rs on rs.seller_account_id = r.id), '[]'::jsonb);
end $$;
revoke execute on function food.admin_invites() from public, anon;
grant execute on function food.admin_invites() to authenticated;

-- Demo: the test shop (Meli) invited two demo cooks, one already rewarded.
do $$
declare
  v_meli uuid := (select seller_account_id from food.shops where is_test limit 1);
begin
  if v_meli is null then return; end if;
  update food.seller_accounts set referred_by = v_meli, invite_rewarded_at = now() - interval '2 days'
   where id = (select seller_account_id from food.shops where slug = 'demo-sweet-layers');
  update food.seller_accounts set referred_by = v_meli
   where id = (select seller_account_id from food.shops where slug = 'demo-green-bowl');
  perform food.grant_free_days(v_meli, 30, 'Invited Sweet Layers by Hana (demo)');
end $$;

create or replace function food.admin_set_invites(p_free_days integer, p_orders_needed integer, p_max_rewards integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_free_days not between 0 and 365 then raise exception 'Free days must be between 0 and 365'; end if;
  if p_orders_needed not between 1 and 100 then raise exception 'Paid orders needed must be between 1 and 100'; end if;
  if p_max_rewards not between 0 and 100 then raise exception 'The most free months must be between 0 and 100'; end if;
  update food.platform_settings set invite_free_days = p_free_days, invite_orders_needed = p_orders_needed, invite_max_rewards = p_max_rewards where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'invite_settings', 'platform_settings', '1',
          jsonb_build_object('invite_free_days', p_free_days, 'invite_orders_needed', p_orders_needed, 'invite_max_rewards', p_max_rewards));
end $$;
revoke execute on function food.admin_set_invites(integer, integer, integer) from public, anon;
grant execute on function food.admin_set_invites(integer, integer, integer) to authenticated;
