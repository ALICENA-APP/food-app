-- Admin-editable platform settings, and simple daily view counts for shops.

create function food.admin_update_settings(p_commission_bps int, p_promo_week_pence int, p_promo_slots int) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  if p_commission_bps not between 0 and 3000 then raise exception 'Commission must be between 0%% and 30%%'; end if;
  if p_promo_week_pence not between 0 and 100000 then raise exception 'Featured price must be between £0 and £1,000 a week'; end if;
  if p_promo_slots not between 0 and 50 then raise exception 'Featured spots must be between 0 and 50'; end if;
  select to_jsonb(s) into v_before from food.platform_settings s where id = 1;
  update food.platform_settings
     set commission_bps = p_commission_bps, promo_week_pence = p_promo_week_pence, promo_slots = p_promo_slots
   where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, before, after)
  values (auth.uid(), 'admin', 'settings_changed', 'platform_settings', '1', v_before,
          jsonb_build_object('commission_bps', p_commission_bps, 'promo_week_pence', p_promo_week_pence, 'promo_slots', p_promo_slots));
end $$;
revoke execute on function food.admin_update_settings(int, int, int) from public, anon;
grant execute on function food.admin_update_settings(int, int, int) to authenticated;

-- One small row per shop per day. Nothing about who viewed is stored.
create table food.shop_daily_views (
  shop_id uuid not null references food.shops (id) on delete cascade,
  day date not null default current_date,
  shop_views integer not null default 0,
  dish_views integer not null default 0,
  featured_clicks integer not null default 0,
  primary key (shop_id, day)
);
alter table food.shop_daily_views enable row level security;
grant select on food.shop_daily_views to authenticated;
create policy "shop views: owner or admin" on food.shop_daily_views
  for select to authenticated using (food.owns_shop(shop_id) or food.is_admin());

create function food.record_view(p_shop uuid, p_kind text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_kind not in ('shop', 'dish', 'featured') or not food.shop_is_public(p_shop) or food.owns_shop(p_shop) then
    return;
  end if;
  insert into food.shop_daily_views (shop_id, day, shop_views, dish_views, featured_clicks)
  values (p_shop, current_date, (p_kind = 'shop')::int, (p_kind = 'dish')::int, (p_kind = 'featured')::int)
  on conflict (shop_id, day) do update
    set shop_views = food.shop_daily_views.shop_views + excluded.shop_views,
        dish_views = food.shop_daily_views.dish_views + excluded.dish_views,
        featured_clicks = food.shop_daily_views.featured_clicks + excluded.featured_clicks;
  -- Keep about six months.
  if random() < 0.01 then
    delete from food.shop_daily_views where day < current_date - 183;
  end if;
end $$;
revoke execute on function food.record_view(uuid, text) from public;
grant execute on function food.record_view(uuid, text) to anon, authenticated;
