-- Launch offer (ALICENA, 19 Oct 2026): new cooks pay no BiteBY fee for their
-- first month (30 days from their first paid order), then the normal 10%.
-- Changeable in Admin > Settings.
update food.platform_settings set intro_commission_bps = 0, intro_days = 30 where id = 1;
alter table food.platform_settings alter column intro_commission_bps set default 0;
