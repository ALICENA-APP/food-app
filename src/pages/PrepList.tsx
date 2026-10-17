import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link, navigate, queryParam } from '../lib/router'
import { Icon } from '../lib/icons'
import { addDays, londonNow, shortDate } from '../lib/hours'
import { ORDER_STATUS, type OrderStatus } from './Orders'

type Row = {
  id: string; code: string; status: OrderStatus; fulfilment: 'collection' | 'delivery'; customer_name: string
  customer_note: string | null; requested_for: string | null; created_at: string
  order_items: { name: string; qty: number }[]
}

// Orders that are going ahead, as opposed to declined, cancelled or unpaid.
const GOING_AHEAD: OrderStatus[] = ['pending_acceptance', 'accepted', 'ready', 'out_for_delivery', 'completed']
const londonDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })

// What to cook on a day: every dish added up, then each order in time order.
export default function PrepList() {
  const today = londonNow().date
  const [day, setDay] = useState(() => {
    const d = queryParam('day')
    return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : today
  })
  const [rows, setRows] = useState<Row[] | null>(null)

  useEffect(() => {
    setRows(null)
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      const { data: shops } = await db.from('shops').select('id').eq('seller_account_id', account?.id ?? '00000000-0000-0000-0000-000000000000')
      const ids = (shops ?? []).map((s) => s.id)
      if (!ids.length) return setRows([])
      // Orders for a day can be placed weeks before, so look back a while.
      const { data } = await db.from('orders')
        .select('id, code, status, fulfilment, customer_name, customer_note, requested_for, created_at, order_items(name, qty)')
        .in('shop_id', ids).in('status', GOING_AHEAD)
        .gte('created_at', new Date(new Date(day + 'T00:00:00Z').getTime() - 45 * 864e5).toISOString())
        .order('created_at').limit(1000)
      setRows(((data ?? []) as Row[]).filter((o) => londonDate(o.requested_for ?? o.created_at) === day))
    })()
  }, [day])

  function pick(d: string) {
    setDay(d)
    navigate(`/sell/prep?day=${d}`, true)
  }

  const totals = new Map<string, number>()
  for (const o of rows ?? []) for (const i of o.order_items) totals.set(i.name, (totals.get(i.name) ?? 0) + i.qty)
  const dishes = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const sorted = [...(rows ?? [])].sort((a, b) => (a.requested_for ?? a.created_at).localeCompare(b.requested_for ?? b.created_at))
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i))

  return (
    <div className="stack">
      <div className="no-print stack">
        <a className="back" href="/sell" onClick={link('/sell')}><Icon name="back" size={18} /> Your shop</a>
        <h1>Cooking list</h1>
        <p className="muted">Everything to make for the day, added up, with each order underneath.</p>
        <div className="chips">
          {days.map((d, i) => (
            <button key={d} type="button" className={`chip ${day === d ? 'on' : ''}`} onClick={() => pick(d)}>
              {i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : shortDate(d)}
            </button>
          ))}
        </div>
      </div>

      {!rows && <p className="muted">Loading…</p>}
      {rows && (
        <article className="printable stack">
          <div className="card stack" style={{ gap: 8 }}>
            <div className="item">
              <h2 style={{ margin: 0 }}>To make · {day === today ? 'today' : shortDate(day)}</h2>
              <span className="muted small">{rows.length} {rows.length === 1 ? 'order' : 'orders'}</span>
            </div>
            {dishes.length === 0 ? <p className="muted">No orders for this day yet.</p> : dishes.map(([name, qty]) => (
              <div key={name} className="item prep-line"><span>{name}</span><strong>× {qty}</strong></div>
            ))}
          </div>

          {sorted.map((o) => (
            <div key={o.id} className="card stack" style={{ gap: 4 }}>
              <div className="item">
                <strong>{o.requested_for ? clock(o.requested_for) : `Ordered ${clock(o.created_at)}`} · {o.fulfilment === 'delivery' ? 'Delivery' : 'Collection'}</strong>
                <span className="muted small">{o.code}</span>
              </div>
              <span className="small">{o.customer_name}{o.status !== 'accepted' ? ` · ${ORDER_STATUS[o.status] ?? o.status}` : ''}</span>
              <span className="small">{o.order_items.map((i) => `${i.qty} × ${i.name}`).join(', ')}</span>
              {o.customer_note && <span className="small muted">Note: {o.customer_note}</span>}
            </div>
          ))}
        </article>
      )}
      {rows && rows.length > 0 && <button type="button" className="secondary no-print" onClick={() => window.print()}>Print or save as PDF</button>}
    </div>
  )
}
