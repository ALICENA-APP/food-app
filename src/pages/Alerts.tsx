import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { markAllRead, type Alert } from '../lib/alerts'
import { when } from './Orders'

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'))

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase!.from('notifications').select('*').order('created_at', { ascending: false }).limit(100)
      setAlerts(data ?? [])
      if (data?.some((a) => !a.read_at)) markAllRead()
    })()
  }, [])

  async function enablePopups() {
    setPermission(await Notification.requestPermission())
  }

  if (!alerts) return <p className="muted">Loading…</p>
  return (
    <div className="stack">
      <h1>Alerts</h1>
      {permission === 'default' && (
        <div className="card">
          <p>Get a pop-up and a sound when something new happens, while the app is open.</p>
          <button onClick={enablePopups}>Turn on pop-up alerts</button>
        </div>
      )}
      {permission === 'denied' && <p className="muted small">Pop-ups are blocked in your browser settings. Alerts still appear here.</p>}
      {alerts.length === 0 && <p className="muted">Nothing yet. You'll see new orders and updates here.</p>}
      {alerts.map((a) => (
        <a key={a.id} className={`card alert ${a.read_at ? '' : 'unread'}`} href={a.link ?? '#'} onClick={a.link ? link(a.link) : undefined}>
          <strong>{a.title}</strong>
          {a.body && <span className="small">{a.body}</span>}
          <span className="muted small">{when(a.created_at)}</span>
        </a>
      ))}
    </div>
  )
}
