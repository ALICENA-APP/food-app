-- 1. Tax details for HMRC's reporting rules for digital platforms: every
--    January BiteBY reports each cook's earnings. Cooks give their date of
--    birth and tax number (National Insurance number or UTR; companies give
--    their company number) and home address. Kept in their own table that
--    only the cook and admins can read.
-- 2. Things that can't be sold on BiteBY (alcoholic drinks, cannabis/CBD,
--    raw milk, medicines) are blocked in dish names and descriptions.

create table food.seller_tax_details (
  seller_account_id uuid primary key references food.seller_accounts (id) on delete cascade,
  date_of_birth date,
  tax_id_kind text not null check (tax_id_kind in ('nino', 'utr', 'company')),
  tax_id text not null check (char_length(tax_id) between 5 and 20),
  company_number text check (company_number ~ '^[A-Z0-9]{8}$'),
  address_line1 text not null check (char_length(address_line1) between 2 and 200),
  address_line2 text check (char_length(address_line2) <= 200),
  city text not null check (char_length(city) between 2 and 100),
  postcode text not null check (char_length(postcode) between 5 and 10),
  updated_at timestamptz not null default now()
);
alter table food.seller_tax_details enable row level security;
grant all on food.seller_tax_details to service_role;
grant select, insert, update on food.seller_tax_details to authenticated;
create policy "tax details: owner or admin reads" on food.seller_tax_details
  for select to authenticated using (seller_account_id = food.my_seller_account_id() or food.is_admin());
create policy "tax details: owner adds" on food.seller_tax_details
  for insert to authenticated with check (seller_account_id = food.my_seller_account_id());
create policy "tax details: owner edits" on food.seller_tax_details
  for update to authenticated using (seller_account_id = food.my_seller_account_id())
  with check (seller_account_id = food.my_seller_account_id());

-- Tidy and check the numbers: NI number "QQ 12 34 56 C", UTR 10 digits, company number 8 characters.
create or replace function food.check_tax_details() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.tax_id := upper(regexp_replace(new.tax_id, '\s', '', 'g'));
  new.company_number := nullif(upper(regexp_replace(coalesce(new.company_number, ''), '\s', '', 'g')), '');
  new.postcode := upper(trim(new.postcode));
  new.updated_at := now();
  if new.tax_id_kind = 'nino' and new.tax_id !~ '^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z][0-9]{6}[A-D]$' then
    raise exception 'That National Insurance number doesn''t look right. It looks like QQ 12 34 56 C.';
  end if;
  if new.tax_id_kind = 'utr' and new.tax_id !~ '^[0-9]{10}$' then
    raise exception 'A UTR (Unique Taxpayer Reference) is 10 numbers.';
  end if;
  if new.tax_id_kind = 'company' then
    if new.company_number is null then new.company_number := new.tax_id; end if;
    if new.company_number !~ '^[A-Z0-9]{8}$' then raise exception 'A company number is 8 characters, like 01234567 or SC123456.'; end if;
  elsif new.date_of_birth is null then
    raise exception 'Add your date of birth.';
  end if;
  if new.date_of_birth is not null and (new.date_of_birth < date '1900-01-01' or new.date_of_birth > current_date - interval '16 years') then
    raise exception 'Check your date of birth.';
  end if;
  return new;
end $$;
create trigger seller_tax_details_check before insert or update on food.seller_tax_details
  for each row execute function food.check_tax_details();

-- Cooks approved before this change: 60 days to add them (HMRC's rules allow two reminders in 60 days).
alter table food.seller_accounts add column tax_details_due date;
update food.seller_accounts set tax_details_due = current_date + 60
 where status = 'approved' and not is_demo;
insert into food.notifications (user_id, title, body, link)
select user_id, 'Add your tax details',
       'HMRC asks marketplaces like BiteBY to report what cooks earn each year. Add your details under Your shop: it takes a minute.', '/sell#tax'
  from food.seller_accounts where tax_details_due is not null and user_id is not null;

-- Applications now need tax details too.
create or replace function food.submit_seller_application() returns food.seller_status
language plpgsql security definer set search_path = '' as $$
declare
  v_account food.seller_accounts;
begin
  select * into v_account from food.seller_accounts where user_id = auth.uid();
  if v_account.id is null then
    raise exception 'No seller account';
  end if;
  if v_account.status not in ('draft', 'reverification_required') then
    raise exception 'Application already submitted';
  end if;
  if v_account.legal_name is null or v_account.business_type is null then
    raise exception 'Add your business details first';
  end if;
  if not exists (select 1 from food.seller_tax_details where seller_account_id = v_account.id) then
    raise exception 'Add your tax details first';
  end if;
  if v_account.terms_accepted_at is null then
    raise exception 'Accept the seller terms first';
  end if;
  if not exists (select 1 from food.seller_verifications
                 where seller_account_id = v_account.id and kind = 'food_registration'
                   and status <> 'rejected') then
    raise exception 'Add your food business registration first';
  end if;
  if not exists (select 1 from food.seller_verifications
                 where seller_account_id = v_account.id and kind = 'allergen_declaration'
                   and status <> 'rejected') then
    raise exception 'Complete the allergen declaration first';
  end if;
  if coalesce((select insurance_required from food.platform_settings where id = 1), true)
     and not food.has_insurance(v_account.id) then
    raise exception 'Upload your food liability insurance first';
  end if;
  update food.seller_accounts
     set status = 'submitted', submitted_at = now()
   where id = v_account.id;
  return 'submitted';
end $$;

-- One reminder a fortnight to cooks who still haven't added them (runs with the insurance reminders).
alter table food.seller_accounts add column tax_reminded_at timestamptz;
create or replace function food.tax_details_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  with due as (
    update food.seller_accounts a set tax_reminded_at = now()
     where a.status = 'approved' and not a.is_demo and a.user_id is not null
       and not exists (select 1 from food.seller_tax_details t where t.seller_account_id = a.id)
       and (a.tax_reminded_at is null or a.tax_reminded_at < now() - interval '14 days')
       and a.approved_at < now() - interval '1 day'
    returning a.user_id
  )
  insert into food.notifications (user_id, title, body, link)
  select user_id, 'Add your tax details',
         'HMRC asks marketplaces like BiteBY to report what cooks earn each year. Add your details under Your shop: it takes a minute.', '/sell#tax'
    from due;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function food.tax_details_reminders() from public, anon, authenticated;

-- The yearly HMRC report: one row per cook who sold that year, with each
-- quarter's paid orders, what customers paid them and BiteBY's fees.
create or replace function food.admin_hmrc_report(p_year int) returns table (
  legal_name text, trading_name text, business_type text, date_of_birth date, tax_id_kind text, tax_id text,
  company_number text, address text, shop_name text,
  q1_orders int, q1_paid_pence bigint, q1_fees_pence bigint,
  q2_orders int, q2_paid_pence bigint, q2_fees_pence bigint,
  q3_orders int, q3_paid_pence bigint, q3_fees_pence bigint,
  q4_orders int, q4_paid_pence bigint, q4_fees_pence bigint,
  missing_details boolean
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  return query
  with o as (
    select s.seller_account_id, extract(quarter from (coalesce(x.paid_at, x.created_at) at time zone 'Europe/London'))::int as q,
           x.total_pence - coalesce(x.service_fee_pence, 0) as paid, x.platform_fee_pence as fee
      from food.orders x join food.shops s on s.id = x.shop_id
     where extract(year from (coalesce(x.paid_at, x.created_at) at time zone 'Europe/London')) = p_year
       and x.status not in ('awaiting_payment', 'declined', 'cancelled', 'expired', 'refunded')
       and not s.is_demo and not s.is_test
  ), sums as (
    select seller_account_id,
      count(*) filter (where q = 1)::int c1, coalesce(sum(paid) filter (where q = 1), 0)::bigint p1, coalesce(sum(fee) filter (where q = 1), 0)::bigint f1,
      count(*) filter (where q = 2)::int c2, coalesce(sum(paid) filter (where q = 2), 0)::bigint p2, coalesce(sum(fee) filter (where q = 2), 0)::bigint f2,
      count(*) filter (where q = 3)::int c3, coalesce(sum(paid) filter (where q = 3), 0)::bigint p3, coalesce(sum(fee) filter (where q = 3), 0)::bigint f3,
      count(*) filter (where q = 4)::int c4, coalesce(sum(paid) filter (where q = 4), 0)::bigint p4, coalesce(sum(fee) filter (where q = 4), 0)::bigint f4
    from o group by seller_account_id
  )
  select a.legal_name, a.trading_name, a.business_type, t.date_of_birth, t.tax_id_kind, t.tax_id, t.company_number,
         concat_ws(', ', t.address_line1, t.address_line2, t.city, t.postcode),
         (select sh.name from food.shops sh where sh.seller_account_id = a.id limit 1),
         s.c1, s.p1, s.f1, s.c2, s.p2, s.f2, s.c3, s.p3, s.f3, s.c4, s.p4, s.f4,
         t.seller_account_id is null
    from sums s join food.seller_accounts a on a.id = s.seller_account_id
    left join food.seller_tax_details t on t.seller_account_id = a.id
   order by a.legal_name;
end $$;
revoke execute on function food.admin_hmrc_report(int) from public, anon;
grant execute on function food.admin_hmrc_report(int) to authenticated;

-- ---------- Things that can't be sold ----------
create or replace function food.banned_item_reason(p_name text, p_description text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  n text := food.squash_words(p_name);
  d text := food.squash_words(p_description);
  w text;
begin
  -- Drinks and drugs, in the name or the description.
  foreach w in array array['cbd', 'thc', 'cannabis', 'marijuana', 'kratom', 'magic mushrooms', 'shrooms', 'psilocybin',
      'raw milk', 'unpasteurised milk', 'unpasteurized milk', 'rawmilk'] loop
    if n ~ food.word_pattern(replace(w, ' ', '')) or d ~ food.word_pattern(replace(w, ' ', '')) then
      return 'BiteBY can’t list cannabis, CBD, drugs or raw (unpasteurised) milk.';
    end if;
  end loop;
  -- Alcoholic drinks for sale, in the name. Food made with drink is fine
  -- ("rum cake", "penne alla vodka", "brandy snaps", "beer-battered fish"),
  -- and so is anything "alcohol-free" or "non-alcoholic".
  foreach w in array array['moonshine', 'homebrew', 'bottle of wine', 'bottles of wine', 'bottle of rum', 'bottle of gin', 'bottle of vodka',
      'bottle of whisky', 'bottle of whiskey', 'bottle of tequila', 'cans of beer', 'crate of beer', 'shots of', 'jello shots', 'jelly shots'] loop
    if n ~ food.word_pattern(replace(w, ' ', '')) then
      return 'BiteBY can’t sell alcoholic drinks (that needs a licence). Food cooked with a little alcohol is fine: say so in the description.';
    end if;
  end loop;
  if n ~ '\|alcohol(ic)?\|' and n !~ '\|non\|?alcohol' and n !~ '\|alcohol\|?free\|' and n !~ '\|no\|alcohol' then
    return 'BiteBY can’t sell alcoholic drinks (that needs a licence). Food cooked with a little alcohol is fine: say so in the description.';
  end if;
  -- Medicines and supplements.
  foreach w in array array['medicine', 'medicinal', 'detox tea', 'weight loss tea', 'slimming tea', 'supplement', 'supplements', 'pills', 'capsules'] loop
    if n ~ food.word_pattern(replace(w, ' ', '')) then
      return 'BiteBY can’t list medicines, supplements or health cures.';
    end if;
  end loop;
  return null;
end $$;
grant execute on function food.banned_item_reason(text, text) to anon, authenticated;

create or replace function food.check_dish_name() returns trigger
language plpgsql set search_path = '' as $$
declare
  v text;
begin
  if food.name_problem(new.name, true) is not null then raise exception '%', food.name_error('That dish name', 'offensive'); end if;
  v := food.banned_item_reason(new.name, new.description);
  if v is not null then raise exception '%', v; end if;
  return new;
end $$;
drop trigger if exists products_name_check on food.products;
create trigger products_name_check before insert or update of name, description on food.products
  for each row execute function food.check_dish_name();
