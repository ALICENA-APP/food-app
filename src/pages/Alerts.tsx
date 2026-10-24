import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { markAllRead, type Alert } from '../lib/alerts'
import { when } from './Orders'
import { PushCard } from '../lib/PushCard'
import { myUserId } from '../lib/session'
import { Icon } from '../lib/icons'

export default function Alerts() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null)
  const [cookUpdates, setCookUpdates] = useState<boolean | null>(null)

  useEffect(() => {
    ;(async () => {
      const { data } = await supabase!.from('notifications').select('*').order('created_at', { ascending: false }).limit(100)
      setAlerts(data ?? [])
      if (data?.some((a) => !a.read_at)) markAllRead()
      const { data: me } = await supabase!.from('profiles').select('cook_updates').eq('id', await myUserId()).maybeSingle()
      setCookUpdates(me?.cook_updates ?? true)
    })()
  }, [])

  async function saveCookUpdates(on: boolean) {
    setCookUpdates(on)
    await supabase!.from('profiles').update({ cook_updates: on }).eq('id', await myUserId())
  }

  if (!alerts) return <p className="muted">Loading…</p>
  return (
    <div className="stack">
      <h1>Alerts</h1>
      <PushCard kind="settings" />
      {cookUpdates !== null && (
        <div className="card push-card">
          <div className="sum-row">
            <span className="set-icon"><Icon name="chef" size={22} filled /></span>
            <span className="sum-text">
              <strong>Updates from cooks</strong>
              <span className="small muted">News from cooks you’ve ordered from or follow, plus one reminder if you leave food in your basket. Usually no more than one a week from each.</span>
            </span>
            <input type="checkbox" className="switch" checked={cookUpdates} onChange={(e) => saveCookUpdates(e.target.checked)} aria-label="Updates from cooks" />
          </div>
        </div>
      )}
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
