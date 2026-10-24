import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { when } from './Orders'

type ClientError = {
  id: number; message: string; stack: string | null; page: string | null; user_agent: string | null; app_version: string | null
  users_seen: number; times: number; first_seen: string; last_seen: string
}
type JobRuns = { last_run: string | null; last_source: string | null; sources: Record<string, string> }

const SOURCE: Record<string, string> = { cron: 'Database timer', netlify: 'Netlify timer', app: 'The app' }

function ago(iso: string | null | undefined) {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 48 * 60) return `${Math.round(mins / 60)} hours ago`
  return `${Math.round(mins / 1440)} days ago`
}

// A short name for the browser, from its user agent.
function device(ua: string | null) {
  if (!ua) return ''
  const os = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : ''
  const browser = /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  return [os, browser].filter(Boolean).join(' · ')
}

// Admin > Bugs: errors people hit in the app, newest first, and whether the
// timers that send reminders are running.
export default function AdminBugs() {
  const [errors, setErrors] = useState<ClientError[] | null>(null)
  const [jobs, setJobs] = useState<JobRuns | null>(null)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const db = supabase!
    const [{ data }, { data: j }] = await Promise.all([
      db.from('client_errors').select('*').order('last_seen', { ascending: false }).limit(100),
      db.from('job_runs').select('last_run, last_source, sources').maybeSingle(),
    ])
    setErrors(data ?? [])
    setJobs(j)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function clear(id?: number) {
    const { error } = await supabase!.rpc('admin_clear_errors', { p_id: id ?? null })
    if (error) return setMessage(error.message)
    load()
  }

  if (!errors) return <p className="muted">Loading…</p>
  const healthy = jobs?.last_run && Date.now() - new Date(jobs.last_run).getTime() < 10 * 60000
  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 6 }}>
        <div className="item">
          <strong>Reminders and order timers</strong>
          <span className={`pill ${healthy ? 'green' : 'yellow'}`}>{healthy ? 'Running' : 'Not running'}</span>
        </div>
        <p className="muted small">Last run {ago(jobs?.last_run)}. These send order reminders, cancel orders cooks didn’t answer and send reorder nudges.</p>
        <div className="stat-list small">
          {Object.entries(SOURCE).map(([k, label]) => (
            <div key={k} className="item"><span>{label}</span><span className="muted">{ago(jobs?.sources?.[k])}</span></div>
          ))}
        </div>
      </div>

      <div className="item">
        <h2>App errors</h2>
        {errors.length > 0 && <button type="button" className="secondary small-btn" onClick={() => clear()}>Clear all</button>}
      </div>
      {errors.length === 0 && <p className="muted">No errors in the last 30 days. Nice.</p>}
      {errors.map((e) => (
        <details key={e.id} className="card bug">
          <summary>
            <span className="sum-text">
              <strong>{e.message}</strong>
              <span className="small muted">{e.times}× · {e.users_seen} {e.users_seen === 1 ? 'person' : 'people'} · last {ago(e.last_seen)}{e.page ? ` · ${e.page}` : ''}</span>
            </span>
          </summary>
          <div className="details-body stack" style={{ gap: 6 }}>
            <p className="muted small">First seen {when(e.first_seen)} · {device(e.user_agent)} · version {e.app_version}</p>
            {e.stack && <pre className="stack-trace">{e.stack}</pre>}
            <button type="button" className="secondary small-btn" onClick={() => clear(e.id)}>Mark as fixed</button>
          </div>
        </details>
      ))}
      {message && <p className="error">{message}</p>}
    </div>
  )
}
