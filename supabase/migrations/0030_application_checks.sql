-- Automatic checks for cook applications. A scheduled job (GitHub Actions,
-- scripts/check-applications.mjs) looks each new application up on the Food
-- Standards Agency register, then record_application_check() adds simple rule
-- checks and gives it green, amber or red. Green ones are approved
-- automatically when Auto-approve is on; the team only looks at amber and red.

alter table food.platform_settings add column auto_approve boolean not null default true;

create table food.application_checks (
  seller_account_id uuid primary key references food.seller_accounts (id) on delete cascade,
  result text not null check (result in ('green', 'amber', 'red')),
  reasons jsonb not null default '[]'::jsonb,   -- [{level: ok|amber|red, text}]
  fsa jsonb,                                     -- what the FSA register said
  auto_approved boolean not null default false,
  recheck boolean not null default false,
  checked_at timestamptz not null default now()
);
alter table food.application_checks enable row level security;
grant select on food.application_checks to authenticated;
create policy "admins read application checks" on food.application_checks for select using (food.is_admin());

-- Council names compare loosely: "London Borough of Havering" = "Havering Council".
create function food.council_key(p text) returns text
language sql immutable set search_path = '' as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(p, '')),
    '(london borough of|royal borough of|borough of|city of|county of|metropolitan|district|borough|city|county|council|the|&|and)', ' ', 'g'),
    '[^a-z]+', ' ', 'g'))
$$;

-- Applications the job should look at: new ones, ones changed since their
-- last check, ones the team asked to recheck, and ones not yet on the FSA
-- register (new registrations can take a few weeks to show), once a day.
create function food.applications_to_check() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id,
           'names', to_jsonb(array_remove(array[a.trading_name, s.name, a.legal_name], null)),
           'postcode', upper(regexp_replace(coalesce(p.postcode, ''), '\s+', '', 'g')),
           'authority', r.authority,
           'reference', r.reference,
           'fhrs_id', h.fhrs_id)), '[]'::jsonb)
    from food.seller_accounts a
    left join food.shops s on s.seller_account_id = a.id
    left join food.shop_private p on p.shop_id = s.id
    left join lateral (select v.authority, v.reference from food.seller_verifications v
                        where v.seller_account_id = a.id and v.kind = 'food_registration' and v.status <> 'rejected'
                        order by v.created_at desc limit 1) r on true
    left join lateral (select v.fhrs_id from food.seller_verifications v
                        where v.seller_account_id = a.id and v.kind = 'hygiene_rating' and v.fhrs_id is not null and v.status <> 'rejected'
                        order by v.created_at desc limit 1) h on true
    left join food.application_checks c on c.seller_account_id = a.id
   where a.status in ('submitted', 'in_review') and not a.is_demo
     and (c.seller_account_id is null or c.recheck or c.checked_at < a.updated_at
          or (c.result <> 'green' and c.checked_at < now() - interval '1 day'
              and coalesce(c.fsa ->> 'status', '') <> 'found' and a.submitted_at > now() - interval '30 days'))
   limit 50
$$;
revoke execute on function food.applications_to_check() from public, anon, authenticated;

-- Adds the rule checks to the FSA result, saves it, and approves green ones.
create function food.record_application_check(p_account uuid, p_fsa jsonb) returns text
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
begin
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
     where seller_account_id = a.id and kind in ('food_registration', 'allergen_declaration') and status = 'pending';
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

-- Admin: ask for a fresh check on the next run.
create function food.admin_recheck_application(p_account uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  update food.application_checks set recheck = true where seller_account_id = p_account;
end $$;
revoke execute on function food.admin_recheck_application(uuid) from public, anon;
grant execute on function food.admin_recheck_application(uuid) to authenticated;

create function food.admin_set_auto_approve(p_on boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not food.is_admin() then raise exception 'Admins only (with two-step sign-in)'; end if;
  update food.platform_settings set auto_approve = p_on where id = 1;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id, after)
  values (auth.uid(), 'admin', 'auto_approve', 'platform_settings', '1', jsonb_build_object('auto_approve', p_on));
end $$;
revoke execute on function food.admin_set_auto_approve(boolean) from public, anon;
grant execute on function food.admin_set_auto_approve(boolean) to authenticated;

-- ---------- Demo: show what each colour looks like ----------
insert into food.application_checks (seller_account_id, result, reasons, fsa, auto_approved, checked_at)
select a.id,
       case row_number() over (order by a.created_at) when 2 then 'amber' when 4 then 'red' else 'green' end,
       case row_number() over (order by a.created_at)
         when 2 then '[{"level":"amber","text":"Not found on the FSA register yet. New registrations can take a few weeks to appear, so this is checked again daily. Meanwhile check their council registration."},{"level":"ok","text":"Postcode and name look fine."}]'::jsonb
         when 4 then '[{"level":"ok","text":"On the FSA register (demo)."},{"level":"red","text":"Hygiene rating 1 of 5: too low to sell on BiteBY. (demo)"}]'::jsonb
         else '[{"level":"ok","text":"On the FSA register (demo)."},{"level":"ok","text":"Hygiene rating 5 of 5."}]'::jsonb end,
       '{"status":"found","demo":true}'::jsonb,
       row_number() over (order by a.created_at) not in (2, 4),
       now() - interval '2 hours'
  from food.seller_accounts a where a.is_demo
on conflict do nothing;
