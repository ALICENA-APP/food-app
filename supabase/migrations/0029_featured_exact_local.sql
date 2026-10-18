-- Featured spots, take two:
-- * A spot lasts exactly what was bought (2 weeks = 14 x 24 hours from the
--   moment it starts), not to the end of a day.
-- * Spots are local. The number of spots counts cooks within the featured
--   area (10 miles by default) of each other, and customers only see featured
--   cooks within that distance of their postcode. A cook in Manchester never
--   takes a London spot, and never shows to a London customer.

alter table food.platform_settings
  add column promo_radius_miles numeric(4, 1) not null default 10 check (promo_radius_miles between 1 and 100);

alter table food.promotions add column starts_at timestamptz, add column ends_at timestamptz;
update food.promotions
   set starts_at = (starts_on::timestamp at time zone 'Europe/London'),
       ends_at = ((ends_on + 1)::timestamp at time zone 'Europe/London')
 where starts_on is not null and ends_on is not null;
create index on food.promotions (status, ends_at);

-- Booked or running spots of cooks within the featured area of a shop.
create function food.promos_near_shop(p_shop uuid) returns setof food.promotions
language sql stable security definer set search_path = '' as $$
  select pr.* from food.promotions pr
    join food.shop_private a on a.shop_id = p_shop
    join food.shop_private b on b.shop_id = pr.shop_id
   where pr.status = 'active' and pr.ends_at > now()
     and (pr.shop_id = p_shop or (a.lat is not null and b.lat is not null
          and food.miles_between(a.lat, a.lng, b.lat, b.lng) <= (select promo_radius_miles from food.platform_settings where id = 1)))
$$;
revoke execute on function food.promos_near_shop(uuid) from public, anon, authenticated;

-- The first moment a spot is free near this shop for the whole run: now, or
-- the moment a nearby spot ends.
drop function food.promo_next_start(int);
create function food.promo_next_start(p_shop uuid, p_weeks int) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_slots int;
  v_len interval := make_interval(days => greatest(p_weeks, 1) * 7);
  c timestamptz;
begin
  select promo_slots into v_slots from food.platform_settings where id = 1;
  if coalesce(v_slots, 0) <= 0 then return null; end if;
  for c in
    select now() union select ends_at from food.promos_near_shop(p_shop) where ends_at > now() order by 1
  loop
    -- Busiest moment in [c, c + run): the start of the window or any start inside it.
    if not exists (
      select 1 from (select c as t union select starts_at from food.promos_near_shop(p_shop) where starts_at > c and starts_at < c + v_len) pts
       where (select count(distinct n.shop_id) from food.promos_near_shop(p_shop) n where n.starts_at <= pts.t and n.ends_at > pts.t) >= v_slots
    ) then
      return c;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function food.promo_next_start(uuid, int) from public, anon, authenticated;

-- Featured cooks for a customer: only those within the featured area of
-- them, in an order that changes daily. No location, no featured row.
drop function food.featured_shops();
create function food.featured_shops(p_lat double precision default null, p_lng double precision default null) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.shop_id from food.promotions p join food.shop_private sp on sp.shop_id = p.shop_id
   where p.status = 'active' and now() >= p.starts_at and now() < p.ends_at
     and food.shop_is_public(p.shop_id)
     and p_lat is not null and sp.lat is not null
     and food.miles_between(sp.lat, sp.lng, p_lat, p_lng) <= (select promo_radius_miles from food.platform_settings where id = 1)
   group by p.shop_id
   order by md5(p.shop_id::text || current_date::text)
   limit (select greatest(promo_slots, 1) from food.platform_settings where id = 1)
$$;
grant execute on function food.featured_shops(double precision, double precision) to anon, authenticated;

create or replace function food.request_promotion(p_weeks int) returns uuid
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
  if exists (select 1 from food.promotions where shop_id = v_shop and (status = 'requested' or (status = 'active' and ends_at > now()))) then
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

create or replace function food.admin_promotions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  return jsonb_build_object(
    'slots', (select promo_slots from food.platform_settings where id = 1),
    'radius', (select promo_radius_miles from food.platform_settings where id = 1),
    'week_pence', (select promo_week_pence from food.platform_settings where id = 1),
    'list', coalesce((
      select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
        select p.*, s.name as shop_name, s.slug, s.is_demo, s.area_label,
               (p.status = 'active' and now() >= p.starts_at and now() < p.ends_at) as running,
               case when p.status = 'requested' then food.promo_next_start(p.shop_id, p.weeks) end as next_start,
               (select count(distinct n.shop_id) from food.promos_near_shop(p.shop_id) n where now() >= n.starts_at and n.ends_at > now()) as in_use_nearby
          from food.promotions p join food.shops s on s.id = p.shop_id
         where p.status in ('requested', 'active') or p.created_at > now() - interval '60 days'
         order by p.created_at desc limit 100
      ) x), '[]'::jsonb));
end $$;

create or replace function food.admin_decide_promotion(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p food.promotions;
  v_owner uuid;
  v_shop text;
  v_start timestamptz;
  v_now boolean;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  select * into p from food.promotions where id = p_id for update;
  if not found then raise exception 'Not found'; end if;
  if p_action = 'approve' then
    if p.status <> 'requested' then raise exception 'Only requests can be approved'; end if;
    -- One approval at a time, so two can't take the same spot.
    perform pg_advisory_xact_lock(hashtext('food.promotions'));
    v_start := food.promo_next_start(p.shop_id, p.weeks);
    if v_start is null then raise exception 'There are no featured spots. Add some under Settings.'; end if;
    v_now := v_start <= now() + interval '1 minute';
    if v_now then v_start := now(); end if;
    update food.promotions
       set status = 'active', starts_at = v_start, ends_at = v_start + make_interval(days => p.weeks * 7),
           starts_on = (v_start at time zone 'Europe/London')::date,
           ends_on = ((v_start + make_interval(days => p.weeks * 7)) at time zone 'Europe/London')::date,
           note = p_note, decided_at = now(), decided_by = auth.uid()
     where id = p_id;
  elsif p_action = 'decline' then
    update food.promotions set status = 'declined', note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
  elsif p_action = 'end' then
    -- Stops now; a booking that hasn't started yet never runs.
    update food.promotions
       set status = 'cancelled', ends_at = greatest(starts_at, least(ends_at, now())),
           note = coalesce(p_note, note), decided_at = now(), decided_by = auth.uid()
     where id = p_id;
  else
    raise exception 'Unknown action';
  end if;
  select food.shop_owner(p.shop_id), name into v_owner, v_shop from food.shops where id = p.shop_id;
  if v_owner is not null and p_action <> 'end' then
    insert into food.notifications (user_id, title, body, link)
    values (v_owner,
            case when p_action <> 'approve' then 'Featured spot request'
                 when v_now then 'You''re featured on BiteBY'
                 else 'Your featured spot is booked' end,
            case when p_action <> 'approve' then coalesce(p_note, 'Your request wasn''t approved this time.')
                 when v_now then v_shop || ' is now in Featured cooks for ' || p.weeks || ' week(s).'
                 else 'All spots near you are taken right now, so ' || v_shop || ' is featured from '
                      || to_char(v_start at time zone 'Europe/London', 'FMDay FMDD FMMonth "at" HH24:MI') || ' for ' || p.weeks || ' week(s).' end,
            '/sell');
  end if;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason)
  values (auth.uid(), 'admin', 'promotion_' || p_action, 'promotions', p_id::text, p_note);
end $$;

-- For the cook: their place among waiting requests nearby, and the earliest start.
create or replace function food.my_promotion_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p food.promotions;
  v_radius numeric;
begin
  select pr.* into p from food.promotions pr join food.shops s on s.id = pr.shop_id join food.seller_accounts a on a.id = s.seller_account_id
   where a.user_id = auth.uid() and pr.status = 'requested' order by pr.created_at limit 1;
  if not found then return null; end if;
  select promo_radius_miles into v_radius from food.platform_settings where id = 1;
  return jsonb_build_object(
    'position', (select count(*) from food.promotions r
                   join food.shop_private a on a.shop_id = p.shop_id join food.shop_private b on b.shop_id = r.shop_id
                  where r.status = 'requested' and r.created_at <= p.created_at
                    and (r.shop_id = p.shop_id or (a.lat is not null and b.lat is not null and food.miles_between(a.lat, a.lng, b.lat, b.lng) <= v_radius))),
    'next_start', food.promo_next_start(p.shop_id, p.weeks));
end $$;

-- Settings: the featured area too.
drop function food.admin_update_settings(int, int, int);
create function food.admin_update_settings(p_commission_bps int, p_promo_week_pence int, p_promo_slots int, p_promo_radius_miles numeric default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_commission_bps not between 0 and 3000 then raise exception 'Commission must be between 0%% and 30%%'; end if;
  if p_promo_week_pence not between 0 and 100000 then raise exception 'Featured price must be between £0 and £1,000 a week'; end if;
  if p_promo_slots not between 0 and 50 then raise exception 'Featured spots must be between 0 and 50'; end if;
  if p_promo_radius_miles is not null and p_promo_radius_miles not between 1 and 100 then raise exception 'Featured area must be between 1 and 100 miles'; end if;
  select to_jsonb(s) into v_before from food.platform_settings s where id = 1;
  update food.platform_settings
     set commission_bps = p_commission_bps, promo_week_pence = p_promo_week_pence, promo_slots = p_promo_slots,
         promo_radius_miles = coalesce(p_promo_radius_miles, promo_radius_miles)
   where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, before, after)
  values (auth.uid(), 'admin', 'settings_changed', 'platform_settings', '1', v_before,
          (select to_jsonb(s) from food.platform_settings s where id = 1));
end $$;
revoke execute on function food.admin_update_settings(int, int, int, numeric) from public, anon;
grant execute on function food.admin_update_settings(int, int, int, numeric) to authenticated;

-- Demo: the test shop's spot started 4 days ago at the time of day it is now.
update food.promotions
   set starts_at = now() - interval '4 days', ends_at = now() - interval '4 days' + interval '14 days'
 where status = 'active' and weeks = 2 and shop_id in (select id from food.shops where is_test);
-- A Manchester demo cook is featured too: it shows to Manchester postcodes only.
insert into food.promotions (shop_id, weeks, status, starts_at, ends_at, starts_on, ends_on, fee_pence, decided_at)
select id, 2, 'active', now() - interval '1 day', now() + interval '13 days', current_date - 1, current_date + 13, 0, now()
  from food.shops where id = '2d4f6211-a979-5d08-8005-29c68d5a4b6c'
   and not exists (select 1 from food.promotions p where p.shop_id = shops.id and p.status in ('active', 'requested'));
