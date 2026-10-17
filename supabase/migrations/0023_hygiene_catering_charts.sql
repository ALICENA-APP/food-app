-- Food hygiene rating badges, catering requests, and daily numbers for the
-- admin overview charts.

-- ---------- Food hygiene ratings ----------
-- Cooks add their rating (a seller_verifications row of kind hygiene_rating);
-- it shows publicly only once the BiteBY team has checked it.
create function food.shop_hygiene(p_shops uuid[]) returns table (shop_id uuid, rating smallint, rating_date date, fhrs_id text)
language sql stable security definer set search_path = '' as $$
  select distinct on (s.id) s.id, v.rating, v.rating_date, v.fhrs_id
    from food.shops s
    join food.seller_verifications v on v.seller_account_id = s.seller_account_id
   where s.id = any (p_shops[1:200])
     and food.shop_is_public(s.id)
     and v.kind = 'hygiene_rating' and v.status = 'accepted' and v.rating is not null
   order by s.id, v.rating_date desc nulls last, v.created_at desc
$$;
revoke execute on function food.shop_hygiene(uuid[]) from public;
grant execute on function food.shop_hygiene(uuid[]) to anon, authenticated;

-- ---------- Catering ----------
alter table food.shop_settings add column takes_catering boolean not null default false;
grant insert (takes_catering), update (takes_catering) on food.shop_settings to authenticated;

-- ---------- Admin charts ----------
create function food.admin_daily_stats(p_days int default 30) returns table (
  day date, orders int, sales_pence bigint, fees_pence bigint, new_users int, new_sellers int
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return query
  with days as (
    select d::date as day
      from generate_series((now() at time zone 'Europe/London')::date - (least(greatest(p_days, 7), 90) - 1),
                           (now() at time zone 'Europe/London')::date, interval '1 day') d
  )
  select days.day,
         (select count(*)::int from food.orders o where o.paid_at is not null and (o.created_at at time zone 'Europe/London')::date = days.day),
         (select coalesce(sum(o.total_pence), 0)::bigint from food.orders o where o.paid_at is not null
            and o.status not in ('declined', 'cancelled', 'expired', 'refunded') and (o.created_at at time zone 'Europe/London')::date = days.day),
         (select coalesce(sum(o.platform_fee_pence), 0)::bigint from food.orders o where o.paid_at is not null
            and o.status not in ('declined', 'cancelled', 'expired', 'refunded') and (o.created_at at time zone 'Europe/London')::date = days.day),
         (select count(*)::int from auth.users u where (u.created_at at time zone 'Europe/London')::date = days.day),
         (select count(*)::int from food.seller_accounts a where not a.is_demo and (a.created_at at time zone 'Europe/London')::date = days.day)
    from days order by days.day;
end $$;
revoke execute on function food.admin_daily_stats(int) from public, anon;
grant execute on function food.admin_daily_stats(int) to authenticated;

-- ---------- Demo shops ----------
insert into food.seller_verifications (seller_account_id, kind, status, rating, rating_date, notes, reviewed_at)
select s.seller_account_id, 'hygiene_rating', 'accepted', case when s.slug = 'demo-green-bowl' then 4 else 5 end,
       (now() - interval '5 months')::date, 'Demo rating (not real)', now()
  from food.shops s where s.is_demo;
update food.shop_settings set takes_catering = true
 where shop_id in (select id from food.shops where is_demo and slug in ('demo-amas-kitchen', 'demo-nanis-kitchen', 'demo-sweet-layers'));
