-- Safer names and steadier shop links.
-- Before: anyone could call themselves (or their shop) something offensive,
-- or "Admin" / "BiteBY Support", and a cook could change their shop link at
-- any time, breaking every QR code and post they'd already shared.
-- Now names are checked (also when disguised: "4dm1n", "a d m i n"), shop
-- links can change once every 30 days once the shop is set up, and old links
-- keep pointing to the shop.

-- Why a name can't be used, or null when it's fine. Words that are also
-- foods (faggots, arroz negro, rapeseed) are only
-- checked for people and shops, not dish names.
create or replace function food.name_problem(p text, p_dish boolean default false) returns text
language plpgsql immutable set search_path = '' as $$
declare
  s text := food.squash_words(p);
  w text;
begin
  if not p_dish then
    -- Pretending to be BiteBY or its team ("BiteBY", "B1teBY", "Admin2", "a d m i n").
    if s ~ '\|b+[il]+t+e+b+y+' or s ~ '\|admin' then return 'staff'; end if;
    foreach w in array array['admin', 'moderator', 'moderators', 'support', 'official', 'staff', 'helpdesk', 'customerservice', 'customerservices', 'customercare'] loop
      if s ~ food.word_pattern(w) then return 'staff'; end if;
    end loop;
    foreach w in array array['faggot', 'faggots', 'fag', 'fags', 'negro', 'rape'] loop
      if s ~ food.word_pattern(w) then return 'offensive'; end if;
    end loop;
  end if;
  -- Swearing, slurs and hate.
  foreach w in array array['fuck', 'fucks', 'fucker', 'fuckers', 'fucking', 'fucked', 'fck', 'fcking', 'fvck', 'fvcking', 'phuck', 'motherfucker',
      'shit', 'shits', 'shite', 'shitty', 'bullshit', 'cunt', 'cunts', 'bitch', 'bitches', 'bastard', 'bastards',
      'dickhead', 'prick', 'twat', 'wanker', 'wank', 'bollocks', 'arsehole', 'asshole', 'piss', 'pissed',
      'pussy', 'slut', 'whore', 'porn', 'porno', 'rapist', 'pedo', 'paedo', 'nonce', 'nazi', 'hitler',
      'nigger', 'niggers', 'nigga', 'niggas', 'tranny', 'retard', 'retarded', 'spastic', 'spaz',
      'paki', 'pakis', 'chink', 'chinky', 'gook', 'kike', 'spic', 'wog', 'coon', 'gypo', 'pikey', 'golliwog', 'raghead', 'towelhead'] loop
    if s ~ food.word_pattern(w) then return 'offensive'; end if;
  end loop;
  return null;
end $$;
grant execute on function food.name_problem(text, boolean) to anon, authenticated;

create or replace function food.name_error(p_what text, p_problem text) returns text
language sql immutable set search_path = '' as $$
  select case p_problem
    when 'staff' then p_what || ' can’t suggest you work for BiteBY (words like admin, support, official or BiteBY). Please pick another one.'
    else p_what || ' includes a word that isn’t allowed on BiteBY. Please pick another one.'
  end
$$;

-- Customer names (profile, and the name on an order, which reviews also use).
create or replace function food.check_person_name() returns trigger
language plpgsql set search_path = '' as $$
declare
  v text;
begin
  if tg_table_name = 'profiles' then
    v := food.name_problem(new.display_name);
  elsif tg_table_name = 'orders' then
    v := food.name_problem(new.customer_name);
  else
    v := food.name_problem(new.trading_name);
  end if;
  if v is not null then raise exception '%', food.name_error('Your name', v); end if;
  return new;
end $$;
create trigger profiles_name_check before insert or update of display_name on food.profiles
  for each row execute function food.check_person_name();
create trigger orders_name_check before insert on food.orders
  for each row execute function food.check_person_name();
create trigger seller_accounts_name_check before insert or update of trading_name on food.seller_accounts
  for each row execute function food.check_person_name();

-- Dish names can't be offensive either (BiteBY words are fine there: "BiteBY special").
create or replace function food.check_dish_name() returns trigger
language plpgsql set search_path = '' as $$
begin
  if food.name_problem(new.name, true) is not null then raise exception '%', food.name_error('That dish name', 'offensive'); end if;
  return new;
end $$;
create trigger products_name_check before insert or update of name on food.products
  for each row execute function food.check_dish_name();

-- Old shop links, so shared posts and printed QR codes keep working.
create table food.shop_old_slugs (
  slug text primary key,
  shop_id uuid not null references food.shops (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index on food.shop_old_slugs (shop_id);
alter table food.shop_old_slugs enable row level security;
grant all on food.shop_old_slugs to service_role;

alter table food.shops add column slug_changed_at timestamptz;

create or replace function food.check_shop_name_link() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v text;
  v_next timestamptz;
begin
  v := food.name_problem(new.name);
  if v is not null then raise exception '%', food.name_error('Your shop name', v); end if;
  v := food.name_problem(replace(new.slug, '-', ' '));
  if v is not null then raise exception '%', food.name_error('Your shop link', v); end if;
  if tg_op = 'INSERT' or new.slug is distinct from old.slug then
    if exists (select 1 from food.shop_old_slugs o where o.slug = new.slug and (tg_op = 'INSERT' or o.shop_id <> new.id)) then
      raise exception 'That link is taken. Try another one.' using errcode = '23505';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.slug is distinct from old.slug then
    -- Free to change while the shop is still being set up.
    if old.status <> 'draft' or exists (select 1 from food.orders where shop_id = old.id) then
      v_next := old.slug_changed_at + interval '30 days';
      if v_next > now() and not food.is_admin() then
        raise exception 'You can change your shop link once every 30 days. You can change it again from %.',
          to_char(v_next at time zone 'Europe/London', 'FMDD FMMonth');
      end if;
      insert into food.shop_old_slugs (slug, shop_id) values (old.slug, old.id)
        on conflict (slug) do update set shop_id = excluded.shop_id, created_at = now();
      new.slug_changed_at := now();
    end if;
    -- Going back to one of your own old links.
    delete from food.shop_old_slugs where slug = new.slug and shop_id = new.id;
  end if;
  return new;
end $$;
create trigger shops_name_link_check before insert or update of name, slug on food.shops
  for each row execute function food.check_shop_name_link();

-- Where an old shop link points now (null when it never existed).
create or replace function food.shop_moved_to(p_slug text) returns text
language sql stable security definer set search_path = '' as $$
  select s.slug from food.shop_old_slugs o join food.shops s on s.id = o.shop_id where o.slug = lower(p_slug)
$$;
grant execute on function food.shop_moved_to(text) to anon, authenticated;

-- For the shop details screen: when the link can next change.
create or replace function food.shop_link_info(p_shop uuid) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'locked_until', case when (s.status <> 'draft' or exists (select 1 from food.orders o where o.shop_id = s.id))
                          and s.slug_changed_at + interval '30 days' > now()
                         then s.slug_changed_at + interval '30 days' end,
    'old_links', (select coalesce(json_agg(o.slug order by o.created_at desc), '[]') from food.shop_old_slugs o where o.shop_id = s.id))
  from food.shops s
  join food.seller_accounts a on a.id = s.seller_account_id
  where s.id = p_shop and (a.user_id = auth.uid() or food.is_admin())
$$;
grant execute on function food.shop_link_info(uuid) to authenticated;

-- Demo: Ama's Kitchen's old link /s/amas-kitchen-e3 still works.
insert into food.shop_old_slugs (slug, shop_id)
select 'amas-kitchen-e3', id from food.shops where is_demo and name = 'Ama''s Kitchen'
on conflict do nothing;
update food.shops set slug_changed_at = now() - interval '10 days' where is_demo and name = 'Ama''s Kitchen';
