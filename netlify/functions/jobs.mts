// A timer that starts the database's job runner every 5 minutes: order
// reminders, cancelling orders the cook didn't answer, reorder nudges and
// insurance/tax reminders. The database also runs it every minute itself
// (pg_cron); this is the backup. Running it twice does no harm.
export default async () => {
  const base = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!base || !key) return
  await fetch(`${base}/rest/v1/rpc/run_jobs`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-profile': 'food' },
    body: JSON.stringify({ p_source: 'netlify' }),
    signal: AbortSignal.timeout(20000),
  })
}

export const config = { schedule: '*/5 * * * *' }
