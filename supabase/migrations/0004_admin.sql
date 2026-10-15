-- Admin tools: approving sellers and checking their documents.
-- Every admin action needs an active admin row AND a two-step (MFA) sign-in,
-- via food.is_admin(). Changes are written to the audit log.

-- First admin: the project owner. Only runs while there are no admins and
-- exactly one person has ever signed in (the owner, who tested sign-in on
-- launch day). Otherwise it does nothing and an admin is added by hand.
insert into food.app_admins (user_id)
select u.id from auth.users u
where (select count(*) from auth.users) = 1
  and not exists (select 1 from food.app_admins);

do $$
begin
  -- Shows up in the migration log so we know whether this worked.
  raise warning 'admins: %, signed-up users: %',
    (select count(*) from food.app_admins), (select count(*) from auth.users);
end $$;

-- Lets the app know whether to offer the admin screen (and ask for the
-- two-step code). It says nothing about other people.
create function food.am_i_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.app_admins a
    where a.user_id = auth.uid() and a.revoked_at is null
  )
$$;
revoke execute on function food.am_i_admin() from public, anon;
grant execute on function food.am_i_admin() to authenticated;

create function food.admin_set_seller_status(
  p_account uuid, p_status food.seller_status, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if p_status in ('reverification_required', 'rejected', 'suspended', 'removed')
     and coalesce(trim(p_note), '') = '' then
    raise exception 'Add a note for the seller';
  end if;
  update food.seller_accounts
     set status = p_status,
         status_note = nullif(trim(p_note), ''),
         approved_by = case when p_status = 'approved' then auth.uid() else approved_by end,
         approved_at = case when p_status = 'approved' then now() else approved_at end
   where id = p_account;
  if not found then
    raise exception 'Seller not found';
  end if;
  -- A seller who is no longer approved can't keep a live shop.
  if p_status <> 'approved' then
    update food.shops set status = 'paused', accepting_orders = false
     where seller_account_id = p_account and status = 'live';
  end if;
end $$;

create function food.admin_review_verification(
  p_id uuid, p_status food.verification_status, p_note text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before food.verification_status;
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  select status into v_before from food.seller_verifications where id = p_id;
  if not found then
    raise exception 'Check not found';
  end if;
  update food.seller_verifications
     set status = p_status, reviewed_by = auth.uid(), reviewed_at = now(),
         notes = coalesce(nullif(trim(p_note), ''), notes)
   where id = p_id;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, before, after)
  values (auth.uid(), 'admin', 'verification_review', 'seller_verifications', p_id::text, p_note,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
end $$;

create function food.admin_set_shop_status(p_shop uuid, p_status food.shop_status, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_before food.shop_status;
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  if p_status = 'live' then
    raise exception 'Only the seller can make their shop live';
  end if;
  select status into v_before from food.shops where id = p_shop;
  if not found then
    raise exception 'Shop not found';
  end if;
  update food.shops
     set status = p_status,
         accepting_orders = case when p_status = 'live' then accepting_orders else false end
   where id = p_shop;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason, before, after)
  values (auth.uid(), 'admin', 'shop_status_change', 'shops', p_shop::text, p_note,
          jsonb_build_object('status', v_before), jsonb_build_object('status', p_status));
end $$;

revoke execute on function
  food.admin_set_seller_status(uuid, food.seller_status, text),
  food.admin_review_verification(uuid, food.verification_status, text),
  food.admin_set_shop_status(uuid, food.shop_status, text)
from public, anon;
grant execute on function
  food.admin_set_seller_status(uuid, food.seller_status, text),
  food.admin_review_verification(uuid, food.verification_status, text),
  food.admin_set_shop_status(uuid, food.shop_status, text)
to authenticated;

-- Sellers' sign-in emails, so an admin can contact them. Admins only.
create function food.admin_seller_emails()
returns table (seller_account_id uuid, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not food.is_admin() then
    raise exception 'Admins only (with two-step sign-in)';
  end if;
  return query
    select a.id, u.email::text from food.seller_accounts a join auth.users u on u.id = a.user_id;
end $$;
revoke execute on function food.admin_seller_emails() from public, anon;
grant execute on function food.admin_seller_emails() to authenticated;
