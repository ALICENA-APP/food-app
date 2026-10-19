-- Demo: Green Bowl already has more than 5 orders, so show its invite as
-- rewarded too (the test shop gets the matching free month).
do $$
declare
  v_meli uuid := (select seller_account_id from food.shops where is_test limit 1);
  v_green uuid := (select seller_account_id from food.shops where slug = 'demo-green-bowl');
begin
  if v_meli is null or v_green is null then return; end if;
  update food.seller_accounts set invite_rewarded_at = now() - interval '1 day'
   where id = v_green and referred_by = v_meli and invite_rewarded_at is null;
  if found then perform food.grant_free_days(v_meli, 30, 'Invited Green Bowl Co (demo)'); end if;
end $$;
