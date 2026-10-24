import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { cookGets } from '../lib/fees'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { pounds } from '../lib/types'

// Payouts: how money from orders reaches the cook's bank. Stripe isn't
// switched on yet, so this is a preview worked out from the cook's real
// completed orders (or examples when there are none).

type Row = { subtotal_pence: number; discount_pence: number | null; delivery_fee_pence: number; platform_fee_pence: number; refunded_pence?: number; completed_at: string }
type Payout = { date: Date; orders: number; amount: number; featured: number; paid: boolean }
type Promo = { fee_pence: number; decided_at: string; weeks: number; takenOn?: Date }

const DAY = 86400000
// Stripe pays out on a rolling basis a few working days after the money comes
// in; the preview uses 3 to be safe.
function addWorkingDays(d: Date, n: number) {
  const x = new Date(d)
  x.setHours(12, 0, 0, 0)
  while (n > 0) {
    x.setTime(x.getTime() + DAY)
    if (x.getDay() !== 0 && x.getDay() !== 6) n--
  }
  return x
}
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const longDay = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
const shortDay = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

function examples(): Row[] {
  const now = Date.now()
  return [1, 2, 2, 4, 6, 9, 9, 13].map((ago, i) => ({
    subtotal_pence: [1800, 2400, 950, 3200, 1500, 2750, 1200, 4100][i], discount_pence: 0,
    delivery_fee_pence: i % 3 === 0 ? 300 : 0, platform_fee_pence: Math.round([1800, 2400, 950, 3200, 1500, 2750, 1200, 4100][i] * 0.1),
    completed_at: new Date(now - ago * DAY).toISOString(),
  }))
}

export default function Payouts() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [example, setExample] = useState(false)
  const [promos, setPromos] = useState<Promo[]>([])

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      const { data: shops } = account ? await db.from('shops').select('id').eq('seller_account_id', account.id) : { data: [] }
      const ids = (shops ?? []).map((s) => s.id as string)
      const { data } = ids.length
        ? await db.from('orders').select('subtotal_pence, discount_pence, delivery_fee_pence, platform_fee_pence, refunded_pence, completed_at')
          .in('shop_id', ids).eq('status', 'completed').gte('completed_at', new Date(Date.now() - 60 * DAY).toISOString())
          .order('completed_at', { ascending: false })
        : { data: [] }
      const { data: p } = ids.length
        ? await db.from('promotions').select('fee_pence, decided_at, weeks').in('shop_id', ids).eq('status', 'active')
          .gte('decided_at', new Date(Date.now() - 60 * DAY).toISOString())
        : { data: [] }
      if (data && data.length) { setRows(data as Row[]); setPromos(((p ?? []) as Promo[]).filter((x) => x.fee_pence > 0)) }
      else {
        setRows(examples())
        setExample(true)
        setPromos([{ fee_pence: 1000, weeks: 2, decided_at: new Date(Date.now() - 5 * DAY).toISOString() }])
      }
    })()
  }, [])

  if (!rows) return <p className="muted">Loading…</p>

  // One payout per day's orders, arriving a few working days later.
  const byDay = new Map<string, Payout>()
  for (const r of rows) {
    const date = addWorkingDays(new Date(r.completed_at), 3)
    const key = dayKey(date)
    const p = byDay.get(key) ?? { date, orders: 0, amount: 0, featured: 0, paid: date.getTime() <= Date.now() }
    p.orders++
    const order = r.subtotal_pence - (r.discount_pence ?? 0) + r.delivery_fee_pence
    p.amount += cookGets({ total_pence: order, platform_fee_pence: r.platform_fee_pence, refunded_pence: r.refunded_pence })
    byDay.set(key, p)
  }
  // Featured spot fees come off the first payout after the spot is approved.
  const ordered = [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime())
  const featured = promos.map((promo) => {
    const target = ordered.find((p) => p.date.getTime() >= new Date(promo.decided_at).getTime())
    if (target) { target.featured += promo.fee_pence; target.amount -= promo.fee_pence }
    return { ...promo, takenOn: target?.date }
  })
  const payouts = [...ordered].reverse()
  const coming = payouts.filter((p) => !p.paid)
  const next = [...coming].sort((a, b) => a.date.getTime() - b.date.getTime())[0]
  const onTheWay = coming.reduce((n, p) => n + p.amount, 0)
  const paid30 = payouts.filter((p) => p.paid && p.date.getTime() > Date.now() - 30 * DAY).reduce((n, p) => n + p.amount, 0)

  return (
    <div className="stack">
      <h1>Payouts</h1>
      <p className="status small">Preview: card payments aren’t switched on yet. This shows how payouts will work{example ? ', using example orders' : ', using your completed orders'}.</p>

      <div className="payout-hero">
        <span className="muted small">Next payout</span>
        <strong className="payout-amount">{next ? pounds(next.amount) : '£0.00'}</strong>
        <span className="small">{next ? `Arrives ${longDay(next.date)}` : 'Nothing on the way right now'}</span>
        <span className="payout-bank"><Icon name="lock" size={14} /> To your bank account ending 1234{example ? ' (example)' : ''}</span>
      </div>

      <div className="payout-stats">
        <div className="card"><strong>{pounds(onTheWay)}</strong><span className="muted tiny">On the way</span></div>
        <div className="card"><strong>{pounds(paid30)}</strong><span className="muted tiny">Paid out, last 30 days</span></div>
      </div>

      <details className="card set-sec">
        <summary>
          <span className="sum-row">
            <span className="set-icon"><Icon name="info" size={20} /></span>
            <span className="sum-text"><strong>How you get paid</strong><span className="muted small">Automatic, straight to your bank</span></span>
          </span>
        </summary>
        <div className="details-body">
          <ol className="payout-steps">
            <li><strong>Customer orders and pays by card.</strong> The money is held, not taken yet.</li>
            <li><strong>You accept the order.</strong> Only then is the card charged. If you decline, the customer pays nothing.</li>
            <li><strong>Stripe sends your money to your bank</strong> automatically, usually within a few working days. Your very first payout can take about a week while Stripe checks your account.</li>
          </ol>
          <p className="muted small">If you book a featured spot, its fee comes off your next payout, so you never need a card.</p>
          <p className="muted small">You get the food price minus BiteBY’s fee, plus all of your delivery fees. Card costs are covered by the customer’s service fee, so they never come off your money. <a href="/fees" onClick={link('/fees')}>How fees work</a></p>
        </div>
      </details>

      <h2 className="payout-h">Payout history</h2>
      <div className="card payout-list">
        {featured.map((f) => (
          <div key={f.decided_at} className="payout-row">
            <span className="sum-text">
              <strong>Paid to be featured</strong>
              <span className="muted tiny">{f.weeks} {f.weeks === 1 ? 'week' : 'weeks'}, approved {shortDay(new Date(f.decided_at))}{f.takenOn ? ` · taken from your ${shortDay(f.takenOn)} payout` : ' · taken from your next payout'}</span>
            </span>
            <span className="payout-right">
              <strong>−{pounds(f.fee_pence)}</strong>
              <span className="payout-tag featured">Featured</span>
            </span>
          </div>
        ))}
        {payouts.map((p) => (
          <div key={dayKey(p.date)} className="payout-row">
            <span className="sum-text">
              <strong>{shortDay(p.date)}</strong>
              <span className="muted tiny">{p.orders} {p.orders === 1 ? 'order' : 'orders'}{p.featured > 0 && ` · after featured fee of ${pounds(p.featured)}`}</span>
            </span>
            <span className="payout-right">
              <strong>{pounds(p.amount)}</strong>
              <span className={`payout-tag ${p.paid ? 'paid' : 'coming'}`}>{p.paid ? 'Paid' : 'On the way'}</span>
            </span>
          </div>
        ))}
      </div>

      <details className="card set-sec">
        <summary>
          <span className="sum-row">
            <span className="set-icon"><Icon name="card" size={20} /></span>
            <span className="sum-text"><strong>Bank details</strong><span className="muted small">Account ending 1234{example ? ' (example)' : ''}</span></span>
          </span>
        </summary>
        <div className="details-body">
          <p className="muted small">Your bank details are kept by Stripe, the secure payment company BiteBY uses. BiteBY never sees them. To change bank, tap below and Stripe opens its secure page. New payouts go to the new account straight away.</p>
          <button type="button" disabled>Update bank details (when payments go live)</button>
          <p className="muted tiny" style={{ margin: 0 }}>New cooks set this up once, in about 5 minutes: name, date of birth and bank details.</p>
        </div>
      </details>
    </div>
  )
}
