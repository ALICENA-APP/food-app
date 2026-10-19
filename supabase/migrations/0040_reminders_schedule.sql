-- Insurance and tax-details reminders also run hourly inside the database
-- (pg_cron), so they don't depend on GitHub's timer, which can skip runs.
-- If pg_cron isn't available the GitHub job still sends them.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'biteby-reminders';
  perform cron.schedule('biteby-reminders', '7 * * * *', 'select food.insurance_reminders(), food.tax_details_reminders()');
exception when others then
  raise notice 'pg_cron not available, reminders run from GitHub only: %', sqlerrm;
end $$;
