-- Profile pictures for everyone. Stored in the public photos bucket under
-- <user id>/..., and only the owner can add, read back or remove them.
alter table food.profiles add column avatar_path text
  check (avatar_path is null or (char_length(avatar_path) <= 200 and avatar_path like (id::text || '/%')));
grant update (avatar_path) on food.profiles to authenticated;

create policy "profile pictures: owner uploads" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "profile pictures: owner reads" on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "profile pictures: owner deletes" on storage.objects
  for delete to authenticated
  using (bucket_id = 'product-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- Deleting an account also clears the profile picture.
create or replace function food.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then raise exception 'Sign in first'; end if;
  if exists (select 1 from food.seller_accounts where user_id = v_user and status not in ('draft', 'rejected', 'removed')) then
    raise exception 'You have a seller account. Contact the BiteBY team to close your shop first.';
  end if;
  if exists (select 1 from food.orders where customer_id = v_user and status in ('pending_acceptance', 'accepted', 'ready', 'out_for_delivery')) then
    raise exception 'You have an order in progress. You can delete your account once it''s finished.';
  end if;
  update food.orders set status = 'cancelled' where customer_id = v_user and status = 'awaiting_payment';
  update food.orders
     set customer_name = 'Deleted customer', customer_phone = null, customer_note = null,
         delivery_address = case when delivery_address is null then null else 'Removed' end
   where customer_id = v_user;
  update food.reviews set reviewer_name = 'Former customer' where customer_id = v_user;
  update food.profiles set display_name = null, phone = null, avatar_path = null, marketing_consent = false, marketing_consent_at = null where id = v_user;
  delete from food.addresses where user_id = v_user;
  delete from food.favourites where user_id = v_user;
  delete from food.notifications where user_id = v_user;
  delete from food.order_messages where sender_id = v_user;
  insert into food.account_deletions (user_id) values (v_user) on conflict do nothing;
  insert into food.audit_log (actor_id, actor_role, action, target_table, target_id)
  values (v_user, 'customer', 'account_deletion_requested', 'auth.users', v_user::text);
end $$;

