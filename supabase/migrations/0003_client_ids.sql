-- Let the app choose the id of a new shop or product, so it can carry on
-- editing it straight away. (Reading a just-inserted row back in the same
-- request fails, because the ownership checks can't see it yet.)
grant insert (id) on food.shops to authenticated;
grant insert (id) on food.products to authenticated;
