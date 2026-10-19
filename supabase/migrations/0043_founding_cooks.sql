-- First 100 founding cooks (ALICENA, 19 Oct 2026).
-- Before: every new cook got the free first month.
-- Now only the first 100 approved cooks do (a "spot" is taken on approval),
-- and the sell page shows how many spots are left. The number is in
-- Admin > Settings; leave it blank to give the offer to everyone again.

alter table food.platform_settings add column intro_spots integer check (intro_spots between 0 and 100000);
update food.platform_settings set intro_spots = 100 where id = 1;

alter table food.seller_accounts add column founding_number integer unique;

-- Cooks already approved keep their offer: they're the first founding cooks.
with ranked as (
  select id, row_number() over (order by approved_at nulls last, created_at) as n
    from food.seller_accounts a0 where status = 'approved' and not is_demo
     and not exists (select 1 from food.shops t where t.seller_account_id = a0.id and t.is_test)
)
update food.seller_accounts a set founding_number = r.n from ranked r where r.id = a.id;

-- A spot is taken when a cook is approved, while spots last.
create or replace function food.claim_founding_spot() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_spots integer;
  v_taken integer;
begin
  if new.status = 'approved' and old.status is distinct from 'approved' and new.founding_number is null and not new.is_demo then
    select intro_spots into v_spots from food.platform_settings where id = 1;
    if v_spots is not null then
      perform pg_advisory_xact_lock(hashtext('food.founding_spots'));
      select count(*) into v_taken from food.seller_accounts where founding_number is not null;
      if v_taken < v_spots then
        new.founding_number := coalesce((select max(founding_number) from food.seller_accounts), 0) + 1;
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger seller_accounts_founding_spot before update of status on food.seller_accounts
  for each row execute function food.claim_founding_spot();

-- For the sell page counter.
create or replace function food.founding_spots() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('total', s.intro_spots,
                            'taken', (select count(*) from food.seller_accounts where founding_number is not null))
    from food.platform_settings s where s.id = 1
$$;
grant execute on function food.founding_spots() to anon, authenticated;

-- Whether this shop's cook gets the welcome offer.
create or replace function food.intro_eligible(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select intro_spots from food.platform_settings where id = 1) is null
      or exists (select 1 from food.shops s join food.seller_accounts a on a.id = s.seller_account_id
                  where s.id = p_shop and (a.founding_number is not null or a.is_demo))
$$;
revoke execute on function food.intro_eligible(uuid) from public;

create or replace function food.shop_commission_bps(p_shop uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case
           when food.shop_free_until(p_shop) is not null then 0
           when coalesce(food.shop_intro_ends(p_shop) > now(), true) and s.intro_days > 0 and food.intro_eligible(p_shop)
             then least(s.intro_commission_bps, s.commission_bps)
           else s.commission_bps end
    from food.platform_settings s where s.id = 1
$$;
revoke execute on function food.shop_commission_bps(uuid) from public;

-- Invite months start after the welcome month only when the cook has one.
create or replace function food.grant_free_days(p_account uuid, p_days integer, p_reason text) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz := now();
  v_intro timestamptz;
  v_shop uuid;
begin
  select id into v_shop from food.shops where seller_account_id = p_account limit 1;
  if v_shop is not null and food.intro_eligible(v_shop) then
    v_intro := food.shop_intro_ends(v_shop);
    v_start := greatest(v_start, coalesce(v_intro, v_start));
  end if;
  v_start := greatest(v_start, coalesce((select max(ends_at) from food.fee_free_periods where seller_account_id = p_account), v_start));
  insert into food.fee_free_periods (seller_account_id, starts_at, ends_at, reason)
  values (p_account, v_start, v_start + make_interval(days => p_days), p_reason);
  return v_start + make_interval(days => p_days);
end $$;
revoke execute on function food.grant_free_days(uuid, integer, text) from public, anon, authenticated;

create or replace function food.my_fee_rate(p_shop uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s food.platform_settings;
  v_ends timestamptz;
  v_ok boolean;
begin
  if not food.owns_shop(p_shop) then raise exception 'Not your shop'; end if;
  select * into s from food.platform_settings where id = 1;
  v_ends := food.shop_intro_ends(p_shop);
  v_ok := food.intro_eligible(p_shop);
  return jsonb_build_object(
    'rate_bps', food.shop_commission_bps(p_shop),
    'standard_bps', s.commission_bps,
    'intro_bps', least(s.intro_commission_bps, s.commission_bps),
    'intro_days', case when v_ok then s.intro_days else 0 end,
    'intro_started', v_ends is not null,
    'intro_ends_at', case when v_ok then v_ends end,
    'founding_number', (select a.founding_number from food.shops sh join food.seller_accounts a on a.id = sh.seller_account_id where sh.id = p_shop),
    'free_until', (select max(p.ends_at) from food.fee_free_periods p join food.shops sh on sh.seller_account_id = p.seller_account_id
                    where sh.id = p_shop and p.ends_at > now()));
end $$;

create or replace function food.admin_set_intro_spots(p_spots integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_spots is not null and p_spots not between 0 and 100000 then raise exception 'Spots must be between 0 and 100,000'; end if;
  update food.platform_settings set intro_spots = p_spots where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'intro_spots', 'platform_settings', '1', jsonb_build_object('intro_spots', p_spots));
end $$;
revoke execute on function food.admin_set_intro_spots(integer) from public, anon;
grant execute on function food.admin_set_intro_spots(integer) to authenticated;
