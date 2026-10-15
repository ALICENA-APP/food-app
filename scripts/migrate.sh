#!/usr/bin/env bash
# Applies supabase/migrations/*.sql in name order, each once, each in its own
# transaction. Applied files are recorded in ops.applied_migrations, a schema
# the Data API never exposes. Needs SUPABASE_DB_URL (session pooler URL).
set -euo pipefail
: "${SUPABASE_DB_URL:?SUPABASE_DB_URL is not set}"
cd "$(dirname "$0")/.."

export PGOPTIONS="-c client_min_messages=warning"
psql_q() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -X -q "$@"; }

psql_q <<'SQL'
create schema if not exists ops;
revoke all on schema ops from public;
create table if not exists ops.applied_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
-- 0001 was run by hand in the SQL editor before this runner existed.
insert into ops.applied_migrations (name)
select '0001_foundation.sql'
where to_regclass('food.allergens') is not null
on conflict do nothing;
SQL

for file in supabase/migrations/*.sql; do
  name=$(basename "$file")
  done_already=$(psql_q -tA -c "select 1 from ops.applied_migrations where name = '$name'")
  if [ "$done_already" = "1" ]; then
    echo "skip   $name"
    continue
  fi
  echo "apply  $name"
  {
    cat "$file"
    printf "\ninsert into ops.applied_migrations (name) values ('%s');\n" "$name"
  } | psql_q --single-transaction
done
echo "migrations up to date"
