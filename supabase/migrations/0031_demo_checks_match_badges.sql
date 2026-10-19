-- The demo application checks in 0030 were coloured by row order, so one
-- demo shop showed "Hygiene rating 1 of 5" while its badge says 5. Rebuild
-- them from each demo shop's real hygiene rating. One shop keeps an amber
-- example (a name difference) that doesn't contradict anything on its page.
with demo as (
  select a.id, row_number() over (order by a.created_at) as n,
         (select max(v.rating) from food.seller_verifications v
           where v.seller_account_id = a.id and v.kind = 'hygiene_rating' and v.status = 'accepted') as rating
    from food.seller_accounts a where a.is_demo
)
update food.application_checks c
   set result = case when d.n = 2 then 'amber' else 'green' end,
       reasons = case when d.n = 2 then
         jsonb_build_array(
           jsonb_build_object('level', 'ok', 'text', 'On the FSA register (demo).'),
           jsonb_build_object('level', 'ok', 'text', format('Hygiene rating %s of 5.', coalesce(d.rating, 5))),
           jsonb_build_object('level', 'amber', 'text', 'The business name on the FSA register is a bit different from the shop name. Worth a quick look. (demo)'))
         else
         jsonb_build_array(
           jsonb_build_object('level', 'ok', 'text', 'On the FSA register (demo).'),
           jsonb_build_object('level', 'ok', 'text', format('Hygiene rating %s of 5.', coalesce(d.rating, 5))))
         end,
       fsa = jsonb_build_object('status', 'found', 'demo', true, 'rating', coalesce(d.rating, 5)::text),
       auto_approved = d.n <> 2
  from demo d
 where c.seller_account_id = d.id;
