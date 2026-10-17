import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { pounds } from '../lib/types'

type Customer = { key: string; name: string; orders: number; spent: number; last: string; favourite: string }

const GONE = ['awaiting_payment', 'declined', 'cancelled', 'expired', 'refunded']

// The cook's customers, regulars first, from their own orders.
export default function SellerCustomers() {
  const [list, setList] = useState<Customer[] | null>(null)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      const { data: shops } = await db.from('shops').select('id').eq('seller_account_id', account?.id ?? '00000000-0000-0000-0000-000000000000')
      const ids = (shops ?? []).map((s) => s.id)
      if (!ids.length) return setList([])
      const { data } = await db.from('orders').select('customer_id, customer_name, status, subtotal_pence, discount_pence, created_at, order_items(name, qty)')
        .in('shop_id', ids).order('created_at', { ascending: false }).limit(3000)
      const by = new Map<string, Customer & { dishes: Map<string, number> }>()
      for (const o of data ?? []) {
        if (GONE.includes(o.status) || o.customer_name === 'Deleted customer') continue
        const key = o.customer_id ?? `name:${o.customer_name}`
        const c = by.get(key) ?? { key, name: o.customer_name, orders: 0, spent: 0, last: o.created_at, favourite: '', dishes: new Map() }
        c.orders += 1
        c.spent += o.subtotal_pence - (o.discount_pence ?? 0)
        for (const i of o.order_items ?? []) c.dishes.set(i.name.split(' (')[0], (c.dishes.get(i.name.split(' (')[0]) ?? 0) + i.qty)
        by.set(key, c)
      }
      setList([...by.values()].map((c) => ({ ...c, favourite: [...c.dishes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' }))
        .sort((a, b) => b.orders - a.orders || b.last.localeCompare(a.last)))
    })()
  }, [])

  const regulars = (list ?? []).filter((c) => c.orders >= 3).length
  return (
    <div className="stack">
      <a className="back" href="/sell" onClick={link('/sell')}><Icon name="back" size={18} /> Your shop</a>
      <h1>Your customers</h1>
      {!list && <p className="muted">Loading…</p>}
      {list && list.length === 0 && <div className="card empty"><span className="big">🙂</span><p>Your customers will appear here after their first order.</p></div>}
      {list && list.length > 0 && (
        <>
          <div className="stats">
            <div><strong>{list.length}</strong><span className="muted tiny">Customers</span></div>
            <div><strong>{regulars}</strong><span className="muted tiny">Regulars (3+ orders)</span></div>
            <div><strong>{list.length ? Math.round((list.filter((c) => c.orders > 1).length / list.length) * 100) : 0}%</strong><span className="muted tiny">Came back</span></div>
          </div>
          <p className="muted small">Thank your regulars with a discount code just for them, under Discount codes.</p>
          {list.map((c) => (
            <div key={c.key} className="card item" style={{ alignItems: 'flex-start' }}>
              <span style={{ minWidth: 0 }}>
                <strong>{c.name}</strong> {c.orders >= 3 && <span className="tag green">Regular</span>}
                <span className="muted small" style={{ display: 'block' }}>
                  {c.orders} {c.orders === 1 ? 'order' : 'orders'} · last {new Date(c.last).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  {c.favourite && ` · loves ${c.favourite}`}
                </span>
              </span>
              <strong>{pounds(c.spent)}</strong>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
