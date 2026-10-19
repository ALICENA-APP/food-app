import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate, queryParam } from '../lib/router'
import { myUserId, useSession } from '../lib/session'
import { Icon } from '../lib/icons'
import { pounds } from '../lib/types'
import { cookGets } from '../lib/fees'
import { downloadCsv, money } from '../lib/csv'
import { ORDER_STATUS, type OrderStatus } from './Orders'

export type StatementKind = 'customer' | 'seller' | 'admin'

type Row = {
  code: string; created_at: string; completed_at: string | null; status: OrderStatus; fulfilment: string
  subtotal_pence: number; discount_pence: number; delivery_fee_pence: number; total_pence: number; platform_fee_pence: number; service_fee_pence: number
  customer_name: string; shops: { name: string } | null; order_items: { name: string; qty: number }[]
}

// The last 12 months, newest first, as "2026-10".
function recentMonths() {
  const now = new Date()
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
}
const monthName = (m: string) => new Date(m + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
const items = (r: Row) => r.order_items.map((i) => `${i.qty} × ${i.name}`).join(', ')
// Orders that went ahead, as opposed to declined, cancelled or never paid.
const counts = (r: Row) => ['completed', 'pending_acceptance', 'accepted', 'ready', 'out_for_delivery'].includes(r.status)

const BACK: Record<StatementKind, { to: string; label: string }> = {
  customer: { to: '/account', label: 'Your data' },
  seller: { to: '/sell/earnings', label: 'Earnings' },
  admin: { to: '', label: '' },
}

// A monthly statement: on screen, printable as a PDF, and as a spreadsheet.
export default function Statement({ kind }: { kind: StatementKind }) {
  const { session } = useSession()
  const months = recentMonths()
  const [month, setMonth] = useState(() => (months.includes(queryParam('month') ?? '') ? queryParam('month')! : months[0]))
  const [rows, setRows] = useState<Row[] | null>(null)
  const [who, setWho] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    setRows(null)
    ;(async () => {
      const db = supabase!
      const uid = await myUserId()
      const start = new Date(month + '-01T00:00:00')
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1)
      let q = db.from('orders')
        .select('code, created_at, completed_at, status, fulfilment, subtotal_pence, discount_pence, delivery_fee_pence, total_pence, service_fee_pence, platform_fee_pence, customer_name, shops(name), order_items(name, qty)')
        .gte('created_at', start.toISOString()).lt('created_at', end.toISOString())
        .order('created_at').limit(5000)
      if (kind === 'customer') {
        q = q.eq('customer_id', uid)
        const { data } = await db.from('profiles').select('display_name').eq('id', uid).maybeSingle()
        setWho(data?.display_name || session?.user.email || '')
      } else if (kind === 'seller') {
        const { data: account } = await db.from('seller_accounts').select('id, legal_name').eq('user_id', uid).maybeSingle()
        const { data: shops } = await db.from('shops').select('id, name').eq('seller_account_id', account?.id ?? '00000000-0000-0000-0000-000000000000')
        q = q.in('shop_id', (shops ?? []).map((s) => s.id)).not('paid_at', 'is', null)
        setWho([shops?.[0]?.name, account?.legal_name].filter(Boolean).join(' · '))
      } else {
        q = q.not('paid_at', 'is', null)
        setWho('All shops')
      }
      const { data, error: err } = await q
      if (err) return setError(err.message)
      setRows((data ?? []) as unknown as Row[])
    })()
  }, [kind, month, session?.user.email])

  function pick(m: string) {
    setMonth(m)
    const q = new URLSearchParams(location.search)
    q.set('month', m)
    navigate(`${location.pathname}?${q}`, true)
  }

  const done = (rows ?? []).filter(counts)
  const sum = (f: (r: Row) => number) => done.reduce((n, r) => n + f(r), 0)
  const food = sum((r) => r.subtotal_pence)
  const discounts = sum((r) => r.discount_pence ?? 0)
  const delivery = sum((r) => r.delivery_fee_pence)
  const fees = sum((r) => r.platform_fee_pence)
  const total = sum((r) => r.total_pence)
  const service = sum((r) => r.service_fee_pence ?? 0)

  function csv() {
    if (!rows) return
    const head = kind === 'customer'
      ? ['Date', 'Order', 'Cook', 'Items', 'Status', 'Food (£)', 'Discount (£)', 'Delivery (£)', 'Service fee (£)', 'Total paid (£)']
      : kind === 'seller'
        ? ['Date', 'Order', 'Customer', 'Items', 'Status', 'Food (£)', 'Your discount (£)', 'Delivery (£)', 'Order value (£)', 'BiteBY fee (£)', 'You earn (£)']
        : ['Date', 'Order', 'Shop', 'Status', 'Food (£)', 'Discount (£)', 'Delivery (£)', 'Service fee (£)', 'Customer paid (£)', 'BiteBY fee (£)', 'Paid to cook (£)']
    const body = rows.map((r) => {
      const date = new Date(r.created_at).toISOString().slice(0, 10)
      const status = ORDER_STATUS[r.status] ?? r.status
      if (kind === 'customer') return [date, r.code, r.shops?.name, items(r), status, money(r.subtotal_pence), money(r.discount_pence), money(r.delivery_fee_pence), money(r.service_fee_pence ?? 0), money(r.total_pence)]
      if (kind === 'seller') return [date, r.code, r.customer_name, items(r), status, money(r.subtotal_pence), money(r.discount_pence), money(r.delivery_fee_pence), money(r.total_pence - (r.service_fee_pence ?? 0)), money(r.platform_fee_pence), money(cookGets(r))]
      return [date, r.code, r.shops?.name, status, money(r.subtotal_pence), money(r.discount_pence), money(r.delivery_fee_pence), money(r.service_fee_pence ?? 0), money(r.total_pence), money(r.platform_fee_pence), money(cookGets(r))]
    })
    downloadCsv(`biteby-${kind === 'customer' ? 'orders' : kind === 'seller' ? 'statement' : 'report'}-${month}.csv`, [head, ...body])
  }

  const title = kind === 'customer' ? 'Your orders' : kind === 'seller' ? 'Monthly statement' : 'Monthly report'
  return (
    <div className="stack">
      <div className="no-print stack">
        {kind !== 'admin' && <a className="back" href={BACK[kind].to} onClick={link(BACK[kind].to)}><Icon name="back" size={18} /> {BACK[kind].label}</a>}
        {kind !== 'admin' && <h1>{title}</h1>}
        <label>
          Month
          <select value={month} onChange={(e) => pick(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
          </select>
        </label>
        <div className="row">
          <button type="button" onClick={() => window.print()} disabled={!rows}>Save as PDF</button>
          <button type="button" className="secondary" onClick={csv} disabled={!rows}>Spreadsheet (CSV)</button>
        </div>
        <p className="muted tiny">“Save as PDF” opens your phone’s print screen. Choose “Save as PDF” or share it from there.</p>
      </div>

      {error && <p className="error">{error}</p>}
      {!rows && !error && <p className="muted">Loading…</p>}
      {rows && (
        <article className="statement printable">
          <header className="statement-head">
            <img src="/logo-word.png" alt="BiteBY" />
            <div>
              <strong>{title}</strong>
              <span>{monthName(month)}</span>
              {who && <span>{who}</span>}
            </div>
          </header>

          <div className="statement-totals">
            <div><span>Orders</span><strong>{done.length}</strong></div>
            {kind === 'customer' && <div><span>You spent</span><strong>{pounds(total)}</strong></div>}
            {kind === 'customer' && discounts > 0 && <div><span>You saved</span><strong>{pounds(discounts)}</strong></div>}
            {kind !== 'customer' && <div><span>Food sales</span><strong>{pounds(food - discounts)}</strong></div>}
            {kind !== 'customer' && <div><span>Delivery</span><strong>{pounds(delivery)}</strong></div>}
            {kind !== 'customer' && <div><span>BiteBY fees</span><strong>{pounds(fees)}</strong></div>}
            {kind === 'seller' && <div><span>You earned</span><strong>{pounds(total - service - fees)}</strong></div>}
            {kind === 'admin' && <div><span>Customers paid</span><strong>{pounds(total)}</strong></div>}
            {kind === 'admin' && <div><span>Service fees (card costs)</span><strong>{pounds(service)}</strong></div>}
          </div>

          {rows.length === 0 ? <p className="muted">No orders in {monthName(month)}.</p> : (
            <table className="statement-table">
              <thead>
                <tr>
                  <th>Date</th><th>Order</th>
                  <th>{kind === 'customer' ? 'Cook' : kind === 'seller' ? 'Customer' : 'Shop'}</th>
                  <th className="num">{kind === 'customer' ? 'Paid' : 'Total'}</th>
                  {kind !== 'customer' && <th className="num">Fee</th>}
                  {kind === 'seller' && <th className="num">You earn</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code} className={counts(r) ? '' : 'void'}>
                    <td>{day(r.created_at)}</td>
                    <td>{r.code}{!counts(r) && <span className="tiny"> · {ORDER_STATUS[r.status] ?? r.status}</span>}</td>
                    <td>
                      {kind === 'seller' ? r.customer_name : r.shops?.name}
                      {kind !== 'admin' && <span className="tiny statement-items">{items(r)}{r.discount_pence ? ` · code −${pounds(r.discount_pence)}` : ''}</span>}
                    </td>
                    <td className="num">{pounds(kind === 'seller' ? r.total_pence - (r.service_fee_pence ?? 0) : r.total_pence)}</td>
                    {kind !== 'customer' && <td className="num">{pounds(r.platform_fee_pence)}</td>}
                    {kind === 'seller' && <td className="num">{pounds(cookGets(r))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tiny muted">
            {kind === 'seller' ? 'Totals count orders that went ahead. Declined, cancelled and refunded orders are shown greyed out and not counted. BiteBY’s fee is taken from the food price after any discount; delivery fees are all yours. Card payment costs are paid by the customer as a service fee, so they never come off your money.'
              : 'Totals count orders that went ahead. Declined, cancelled and refunded orders are shown greyed out and not counted.'}
            {' '}Made {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.
          </p>
        </article>
      )}
    </div>
  )
}
