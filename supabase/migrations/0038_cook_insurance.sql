-- Cooks must have food liability insurance (public and products liability).
-- They upload the certificate and its expiry date; while it's valid their
-- shop shows an "Insured" badge. Reminders go out 30 and 7 days before it
-- runs out, and a shop without valid insurance is hidden from customers
-- automatically until a new certificate is uploaded. Admin > Settings can
-- turn the requirement off.

alter table food.platform_settings add column insurance_required boolean not null default true;

-- Cooks approved before this change get 30 days to upload theirs.
alter table food.seller_accounts add column insurance_due date;

alter table food.seller_verifications
  add column reminded_30_at timestamptz,
  add column reminded_7_at timestamptz,
  add column expired_notified_at timestamptz;

create or replace function food.uk_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Europe/London')::date
$$;

-- A current certificate (uploaded, or entered by the BiteBY team).
create or replace function food.has_insurance(p_account uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.seller_verifications v
     where v.seller_account_id = p_account and v.kind = 'insurance' and v.status <> 'rejected'
       and (v.document_path is not null or v.status = 'accepted')
       and v.expires_at >= food.uk_today())
$$;

-- Whether the cook may sell: insured, still in their 30 days' grace, or insurance isn't required.
create or replace function food.insurance_ok(p_account uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select not coalesce((select insurance_required from food.platform_settings where id = 1), true)
      or food.has_insurance(p_account)
      or coalesce((select a.insurance_due >= food.uk_today() from food.seller_accounts a where a.id = p_account), false)
$$;

-- Shops without valid insurance are hidden from customers (and can't take orders).
create or replace function food.shop_is_public(p_shop uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from food.shops s
    join food.seller_accounts a on a.id = s.seller_account_id
    where s.id = p_shop and s.status = 'live'
      and a.status = 'approved' and a.charges_enabled
      and food.insurance_ok(a.id)
  )
$$;

-- Certificates must have a file and a sensible expiry date.
create or replace function food.check_insurance_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind <> 'insurance' or auth.uid() is null or food.is_admin() then return new; end if;
  if tg_op = 'UPDATE' and new.expires_at is not distinct from old.expires_at
     and new.document_path is not distinct from old.document_path then return new; end if;
  if new.document_path is null then raise exception 'Upload a photo or PDF of your insurance certificate.'; end if;
  if new.expires_at is null then raise exception 'Add the date your insurance runs out.'; end if;
  if new.expires_at < food.uk_today() then raise exception 'That insurance has already run out. Upload your current certificate.'; end if;
  if new.expires_at > food.uk_today() + interval '3 years' then raise exception 'Check the date your insurance runs out: it looks too far ahead.'; end if;
  return new;
end $$;
create trigger seller_verifications_insurance before insert or update on food.seller_verifications
  for each row execute function food.check_insurance_row();

-- Applications need insurance when it's required.
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

-- "Insured" badges for shop pages.
create or replace function food.shops_insured(p_shops uuid[]) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.id from food.shops s
   where s.id = any (p_shops[1:200]) and food.shop_is_public(s.id) and food.has_insurance(s.seller_account_id)
$$;
revoke execute on function food.shops_insured(uuid[]) from public;
grant execute on function food.shops_insured(uuid[]) to anon, authenticated;

-- Run every 15 minutes with the application checks: reminders before the
-- insurance runs out, and a note when the shop has been hidden.
create or replace function food.insurance_reminders() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n integer := 0;
  v_days integer;
begin
  if not coalesce((select insurance_required from food.platform_settings where id = 1), true) then return 0; end if;
  for r in
    select a.id as account_id, a.user_id, a.insurance_due, v.id as ver_id, v.expires_at, v.reminded_30_at, v.reminded_7_at, v.expired_notified_at
      from food.seller_accounts a
      left join lateral (
        select * from food.seller_verifications x
         where x.seller_account_id = a.id and x.kind = 'insurance' and x.status <> 'rejected'
         order by x.expires_at desc nulls last, x.created_at desc limit 1) v on true
     where a.status = 'approved' and not a.is_demo and a.user_id is not null
  loop
    if r.ver_id is null then
      -- Cooks from before insurance was needed: remind during their grace period.
      continue;
    end if;
    v_days := r.expires_at - food.uk_today();
    if v_days < 0 then
      if r.expired_notified_at is null and not food.insurance_ok(r.account_id) then
        insert into food.notifications (user_id, title, body, link)
        values (r.user_id, 'Your shop is hidden: insurance ran out',
                'Customers can’t see or order from your shop until you upload your new insurance certificate.', '/sell#insurance');
        update food.seller_verifications set expired_notified_at = now() where id = r.ver_id;
        n := n + 1;
      end if;
    elsif v_days <= 7 then
      if r.reminded_7_at is null then
        insert into food.notifications (user_id, title, body, link)
        values (r.user_id, 'Your insurance runs out in ' || v_days || case when v_days = 1 then ' day' else ' days' end,
                'Upload your renewed certificate so your shop stays open to customers.', '/sell#insurance');
        update food.seller_verifications set reminded_7_at = now(), reminded_30_at = coalesce(reminded_30_at, now()) where id = r.ver_id;
        n := n + 1;
      end if;
    elsif v_days <= 30 then
      if r.reminded_30_at is null then
        insert into food.notifications (user_id, title, body, link)
        values (r.user_id, 'Your insurance runs out on ' || to_char(r.expires_at, 'FMDD FMMonth'),
                'Renew it and upload the new certificate, so your shop stays open to customers.', '/sell#insurance');
        update food.seller_verifications set reminded_30_at = now() where id = r.ver_id;
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $$;
revoke execute on function food.insurance_reminders() from public, anon, authenticated;

create or replace function food.admin_set_insurance_required(p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  update food.platform_settings set insurance_required = p_on where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'insurance_required', 'platform_settings', '1', jsonb_build_object('insurance_required', p_on));
end $$;
revoke execute on function food.admin_set_insurance_required(boolean) from public, anon;
grant execute on function food.admin_set_insurance_required(boolean) to authenticated;

-- Automatic application checks now look at insurance too.
create or replace function food.record_application_check(p_account uuid, p_fsa jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  a food.seller_accounts;
  s food.shops;
  pv food.shop_private;
  reg food.seller_verifications;
  reasons jsonb := '[]'::jsonb;
  v_result text;
  v_rating text := p_fsa ->> 'rating';
  v_auto boolean;
  v_dupe record;
  v_bad text;
  v_approve boolean := false;
  ins food.seller_verifications;
  v_ins_required boolean;
begin
  select insurance_required into v_ins_required from food.platform_settings where id = 1;
  select * into a from food.seller_accounts where id = p_account;
  if not found then return null; end if;
  select * into s from food.shops where seller_account_id = a.id limit 1;
  select * into pv from food.shop_private where shop_id = s.id;
  select * into reg from food.seller_verifications
   where seller_account_id = a.id and kind = 'food_registration' and status <> 'rejected' order by created_at desc limit 1;

  -- 1. Food Standards Agency register.
  if p_fsa ->> 'status' = 'found' then
    reasons := reasons || jsonb_build_object('level', 'ok', 'text',
      'On the FSA register as "' || coalesce(p_fsa ->> 'name', '?') || '", ' || coalesce(p_fsa ->> 'authority', 'council not given') || '.');
    if v_rating ~ '^[0-5]$' then
      reasons := reasons || jsonb_build_object('level', case when v_rating::int >= 3 then 'ok' else 'red' end, 'text',
        'Hygiene rating ' || v_rating || ' of 5' || case when v_rating::int >= 3 then '.' else ': too low to sell on BiteBY.' end);
    elsif v_rating ilike 'awaiting%' then
      reasons := reasons || jsonb_build_object('level', 'ok', 'text', 'Registered and waiting for the first council inspection.');
    else
      reasons := reasons || jsonb_build_object('level', 'amber', 'text', 'FSA rating shows as "' || coalesce(v_rating, 'blank') || '". Have a look.');
    end if;
    if reg.authority is not null and p_fsa ->> 'authority' is not null
       and position(food.council_key(reg.authority) in food.council_key(p_fsa ->> 'authority')) = 0
       and position(food.council_key(p_fsa ->> 'authority') in food.council_key(reg.authority)) = 0 then
      reasons := reasons || jsonb_build_object('level', 'amber', 'text',
        'They said ' || reg.authority || ' council, but the FSA lists ' || (p_fsa ->> 'authority') || '.');
    end if;
    if coalesce(p_fsa ->> 'postcode_match', 'true') = 'false' then
      reasons := reasons || jsonb_build_object('level', 'amber', 'text', 'The FSA postcode doesn''t match their shop postcode.');
    end if;
  else
    reasons := reasons || jsonb_build_object('level', 'amber', 'text',
      'Not found on the FSA register yet. New registrations can take a few weeks to appear, so this is checked again daily. ' ||
      'Meanwhile check their council registration' || coalesce(' (' || reg.authority || coalesce(', ref ' || reg.reference, '') || ')', '') || '.');
  end if;

  -- 2. Postcode.
  if coalesce(pv.postcode, '') = '' then
    reasons := reasons || jsonb_build_object('level', 'amber', 'text', 'No shop postcode yet, so the FSA match couldn''t use the address.');
  elsif upper(pv.postcode) !~ '^\s*[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}\s*$' then
    reasons := reasons || jsonb_build_object('level', 'amber', 'text', 'The postcode "' || pv.postcode || '" doesn''t look like a UK postcode.');
  end if;

  -- 3. Full name.
  if coalesce(array_length(regexp_split_to_array(trim(coalesce(a.legal_name, '')), '\s+'), 1), 0) < 2 then
    reasons := reasons || jsonb_build_object('level', 'amber', 'text', 'Legal name "' || coalesce(a.legal_name, '') || '" looks incomplete.');
  end if;

  -- 4. Second accounts: same phone, or same postcode and name.
  select o.id, o.status, o.legal_name into v_dupe
    from food.seller_accounts o
    left join food.shops os on os.seller_account_id = o.id
    left join food.shop_private op on op.shop_id = os.id
   where o.id <> a.id and not o.is_demo and o.status <> 'draft'
     and ((pv.contact_phone is not null and regexp_replace(op.contact_phone, '\D', '', 'g') = regexp_replace(pv.contact_phone, '\D', '', 'g')
           and length(regexp_replace(pv.contact_phone, '\D', '', 'g')) >= 10)
       or (pv.postcode is not null and upper(replace(op.postcode, ' ', '')) = upper(replace(pv.postcode, ' ', ''))
           and lower(o.legal_name) = lower(a.legal_name)))
   order by (o.status in ('suspended', 'removed', 'rejected')) desc
   limit 1;
  if v_dupe.id is not null then
    reasons := reasons || jsonb_build_object('level', case when v_dupe.status in ('suspended', 'removed', 'rejected') then 'red' else 'amber' end, 'text',
      'Looks like another account (' || coalesce(v_dupe.legal_name, '?') || ', ' || v_dupe.status || ') with the same phone or address.');
  end if;

  -- 5. Off-app payment or contact details in their names or story.
  v_bad := coalesce(food.off_app_reason(a.legal_name), food.off_app_reason(a.trading_name), food.off_app_reason(s.name), food.off_app_reason(s.story));
  if v_bad is not null then
    reasons := reasons || jsonb_build_object('level', 'red', 'text', 'Their shop text breaks the rules: ' || v_bad || '.');
  end if;

  -- 6. Terms.
  if a.terms_accepted_at is null then
    reasons := reasons || jsonb_build_object('level', 'red', 'text', 'Seller terms not agreed.');
  end if;

  -- 7. Food liability insurance.
  select * into ins from food.seller_verifications
   where seller_account_id = a.id and kind = 'insurance' and status <> 'rejected'
   order by expires_at desc nulls last, created_at desc limit 1;
  if ins.id is null or ins.expires_at < food.uk_today() then
    if coalesce(v_ins_required, true) then
      reasons := reasons || jsonb_build_object('level', 'red', 'text', 'No valid food liability insurance uploaded.');
    end if;
  else
    reasons := reasons || jsonb_build_object('level', case when ins.expires_at < food.uk_today() + 30 then 'amber' else 'ok' end, 'text',
      'Insurance' || coalesce(' with ' || ins.authority, '') || ' valid until ' || to_char(ins.expires_at, 'FMDD Mon YYYY') ||
      case when ins.expires_at < food.uk_today() + 30 then ': runs out within 30 days.' else '. The certificate is on their application.' end);
  end if;

  v_result := case when reasons @> '[{"level": "red"}]' then 'red'
                   when reasons @> '[{"level": "amber"}]' then 'amber' else 'green' end;
  select auto_approve into v_auto from food.platform_settings where id = 1;
  v_approve := v_result = 'green' and coalesce(v_auto, false) and a.status = 'submitted';

  insert into food.application_checks (seller_account_id, result, reasons, fsa, auto_approved, recheck, checked_at)
  values (a.id, v_result, reasons, p_fsa, v_approve, false, now())
  on conflict (seller_account_id) do update
    set result = excluded.result, reasons = excluded.reasons, fsa = excluded.fsa,
        auto_approved = excluded.auto_approved, recheck = false, checked_at = now();

  if v_approve then
    update food.seller_accounts set status = 'approved', approved_at = now(), approved_by = null,
           status_note = 'Approved automatically after the FSA and safety checks.'
     where id = a.id;
    update food.seller_verifications set status = 'accepted', reviewed_at = now(),
           notes = coalesce(notes, 'Checked automatically on the FSA register')
     where seller_account_id = a.id and kind in ('food_registration', 'allergen_declaration', 'insurance') and status = 'pending';
    -- The FSA rating becomes their hygiene badge.
    if v_rating ~ '^[0-5]$' then
      insert into food.seller_verifications (seller_account_id, kind, status, rating, rating_date, fhrs_id, notes, reviewed_at)
      values (a.id, 'hygiene_rating', 'accepted', v_rating::smallint, nullif(p_fsa ->> 'rating_date', '')::date,
              left(p_fsa ->> 'fhrs_id', 20), 'From the FSA register', now());
    end if;
    insert into food.notifications (user_id, title, body, link)
    values (a.user_id, 'You''re approved on BiteBY',
            'Your details checked out. Finish your shop setup and connect payments to go live.', '/sell');
    insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason)
    values (null, 'system', 'seller_auto_approved', 'seller_accounts', a.id::text, 'Green on automatic checks');
  end if;
  return v_result;
end $$;
revoke execute on function food.record_application_check(uuid, jsonb) from public, anon, authenticated;

-- Existing approved cooks: 30 days to upload, and a note telling them.
update food.seller_accounts a set insurance_due = food.uk_today() + 30
 where a.status = 'approved' and not a.is_demo and not food.has_insurance(a.id)
   and not exists (select 1 from food.shops s where s.seller_account_id = a.id and s.is_test);
insert into food.notifications (user_id, title, body, link)
select a.user_id, 'Add your food insurance by ' || to_char(a.insurance_due, 'FMDD FMMonth'),
       'BiteBY now asks every cook for food liability insurance. Upload your certificate to keep your shop open.', '/sell#insurance'
  from food.seller_accounts a where a.insurance_due is not null and a.user_id is not null;

-- Demo shops and the test shop: insured for a year, so the badge shows.
insert into food.seller_verifications (seller_account_id, kind, status, authority, reference, document_path, expires_at, notes, reviewed_at)
select a.id, 'insurance', 'accepted', 'Demo Insurance Ltd', 'DEMO-' || upper(left(md5(a.id::text), 6)), null,
       food.uk_today() + 365, 'Sample insurance for the demo', now()
  from food.seller_accounts a
 where (a.is_demo or exists (select 1 from food.shops s where s.seller_account_id = a.id and s.is_test))
   and not food.has_insurance(a.id);
