-- Lighter cook sign-up.
-- Before: a cook couldn't send their application until they'd uploaded an
-- insurance certificate and added their tax details.
-- Now the application only asks the basics (about you, food registration,
-- allergen promise, terms). Insurance is still needed before customers can
-- see the shop (shop_is_public already checks it), and tax details are due
-- within 60 days of approval, with the usual reminders.

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
  update food.seller_accounts
     set status = 'submitted', submitted_at = now()
   where id = v_account.id;
  return 'submitted';
end $$;

-- Missing insurance no longer holds up approval: the shop just stays hidden until it's uploaded.
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
      reasons := reasons || jsonb_build_object('level', 'ok', 'text', 'No insurance uploaded yet. Their shop stays hidden from customers until they add it.');
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
            'Your details checked out. Finish your shop setup, upload your food insurance and connect payments to go live.', '/sell');
    insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, reason)
    values (null, 'system', 'seller_auto_approved', 'seller_accounts', a.id::text, 'Green on automatic checks');
  end if;
  return v_result;
end $$;

-- Tax details: 60 days from approval.
create or replace function food.set_tax_due_on_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' and new.tax_details_due is null and not new.is_demo
     and not exists (select 1 from food.seller_tax_details t where t.seller_account_id = new.id) then
    new.tax_details_due := food.uk_today() + 60;
  end if;
  return new;
end $$;
create trigger seller_accounts_tax_due before update of status on food.seller_accounts
  for each row execute function food.set_tax_due_on_approval();
