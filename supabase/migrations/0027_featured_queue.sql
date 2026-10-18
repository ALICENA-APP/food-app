-- Featured spots: when every spot is taken, an approved request is booked to
-- start on the first day a spot frees up, instead of being refused. Cooks see
-- how many days they have left, or their place in the queue.

-- The first day from which a spot is free for the whole run.
create function food.promo_next_start(p_weeks int) returns date
language plpgsql stable security definer set search_path = '' as $$
declare
  v_slots int;
  v_len int := greatest(p_weeks, 1) * 7;
  d date;
begin
  select promo_slots into v_slots from food.platform_settings where id = 1;
  if coalesce(v_slots, 0) <= 0 then return null; end if;
  for i in 0..365 loop
    d := current_date + i;
    if not exists (
      select 1 from generate_series(d, d + v_len - 1, interval '1 day') g(day)
       where (select count(distinct p.shop_id) from food.promotions p
               where p.status = 'active' and g.day::date between p.starts_on and p.ends_on) >= v_slots
    ) then
      return d;
    end if;
  end loop;
  return null;
end $$;
revoke execute on function food.promo_next_start(int) from public, anon, authenticated;

create or replace function food.admin_promotions() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  return jsonb_build_object(
    'slots', (select promo_slots from food.platform_settings where id = 1),
    'week_pence', (select promo_week_pence from food.platform_settings where id = 1),
    'list', coalesce((
      select jsonb_agg(row_to_json(x) order by x.created_at desc) from (
        select p.*, s.name as shop_name, s.slug, s.is_demo,
               (p.status = 'active' and current_date between p.starts_on and p.ends_on) as running,
               case when p.status = 'requested' then food.promo_next_start(p.weeks) end as next_start
          from food.promotions p join food.shops s on s.id = p.shop_id
         where p.status in ('requested', 'active') or p.created_at > now() - interval '60 days'
         order by p.created_at desc limit 100
      ) x), '[]'::jsonb));
end $$;

-- Approve now books the next free spot (today if one is free).
create or replace function food.admin_decide_promotion(p_id uuid, p_action text, p_note text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare
  p food.promotions;
  v_owner uuid;
  v_shop text;
  v_start date;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  select * into p from food.promotions where id = p_id for update;
  if not found then raise exception 'Not found'; end if;
  if p_action = 'approve' then
    if p.status <> 'requested' then raise exception 'Only requests can be approved'; end if;
    -- One approval at a time, so two can't take the same spot.
    perform pg_advisory_xact_lock(hashtext('food.promotions'));
    v_start := food.promo_next_start(p.weeks);
    if v_start is null then raise exception 'There are no featured spots. Add some under Settings.'; end if;
    update food.promotions set status = 'active', starts_on = v_start, ends_on = v_start + p.weeks * 7 - 1,
           note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
  elsif p_action = 'decline' then
    update food.promotions set status = 'declined', note = p_note, decided_at = now(), decided_by = auth.uid() where id = p_id;
  elsif p_action = 'end' then
    -- A booking that hasn't started yet is simply cancelled.
    update food.promotions set status = 'cancelled', ends_on = greatest(starts_on - 1, least(ends_on, current_date - 1)),
           note = coalesce(p_note, note), decided_at = now(), decided_by = auth.uid() where id = p_id;
  else
    raise exception 'Unknown action';
  end if;
  select food.shop_owner(p.shop_id), name into v_owner, v_shop from food.shops where id = p.shop_id;
  if v_owner is not null and p_action <> 'end' then
    insert into food.notifications (user_id, title, body, link)
    values (v_owner,
            case when p_action <> 'approve' then 'Featured spot request'
                 when v_start = current_date then 'You''re featured on BiteBY'
                 else 'Your featured spot is booked' end,
            case when p_action <> 'approve' then coalesce(p_note, 'Your request wasn''t approved this time.')
                 when v_start = current_date then v_shop || ' is now in Featured cooks for ' || p.weeks || ' week(s).'
                 else 'All spots are taken right now, so ' || v_shop || ' is featured from ' || to_char(v_start, 'FMDay FMDD FMMonth') || ' for ' || p.weeks || ' week(s).' end,
            '/sell');
  end if;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason)
  values (auth.uid(), 'admin', 'promotion_' || p_action, 'promotions', p_id::text, p_note);
end $$;

-- For the cook: their place among waiting requests and the earliest start.
create function food.my_promotion_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p food.promotions;
begin
  select pr.* into p from food.promotions pr join food.shops s on s.id = pr.shop_id join food.seller_accounts a on a.id = s.seller_account_id
   where a.user_id = auth.uid() and pr.status = 'requested' order by pr.created_at limit 1;
  if not found then return null; end if;
  return jsonb_build_object(
    'position', (select count(*) from food.promotions where status = 'requested' and created_at <= p.created_at),
    'next_start', food.promo_next_start(p.weeks));
end $$;
revoke execute on function food.my_promotion_queue() from public, anon;
grant execute on function food.my_promotion_queue() to authenticated;

-- ---------- Demo: the test shop is featured part-way through, Rosa is waiting ----------
insert into food.promotions (shop_id, weeks, status, starts_on, ends_on, fee_pence, decided_at)
select id, 2, 'active', current_date - 4, current_date + 9, 0, now() from food.shops
 where is_test and not exists (select 1 from food.promotions p where p.shop_id = shops.id and p.status in ('active', 'requested'));
insert into food.promotions (shop_id, weeks, status, fee_pence, created_at)
select id, 2, 'requested', 2 * (select promo_week_pence from food.platform_settings where id = 1), now() - interval '3 hours' from food.shops
 where id = '0c454c2f-dcbd-54e9-9fb6-54b7175453b5' and not exists (select 1 from food.promotions p where p.shop_id = shops.id and p.status in ('active', 'requested'));
