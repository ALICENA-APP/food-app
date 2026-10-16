import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { pounds } from '../lib/types'
import { ReviewItem, type Review } from '../lib/reviews'
import { ORDER_STATUS, when, type Order, type OrderStatus } from './Orders'

const FILTERS: { key: string; label: string; statuses: OrderStatus[] | null }[] = [
  { key: 'open', label: 'Open', statuses: ['pending_acceptance', 'accepted', 'ready', 'out_for_delivery'] },
  { key: 'unpaid', label: 'Unpaid', statuses: ['awaiting_payment'] },
  { key: 'done', label: 'Finished', statuses: ['completed', 'declined', 'cancelled', 'expired', 'refunded'] },
  { key: 'all', label: 'All', statuses: null },
]

// Every order on the platform, newest first, with totals for the platform.
export function AdminOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null)
  const [filter, setFilter] = useState('open')

  const load = useCallback(async () => {
    const { data } = await supabase!
      .from('orders')
      .select('*, shops(name, slug)')
      .order('created_at', { ascending: false })
      .limit(500)
    setOrders(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!orders) return <p className="muted">Loading…</p>
  const statuses = FILTERS.find((f) => f.key === filter)!.statuses
  const shown = orders.filter((o) => !statuses || statuses.includes(o.status))
  const completed = orders.filter((o) => o.status === 'completed')
  const fees = completed.reduce((n, o) => n + o.platform_fee_pence, 0)
  const sales = completed.reduce((n, o) => n + o.total_pence, 0)

  return (
    <div className="stack">
      <div className="card">
        <div className="item"><span>Completed orders</span><strong>{completed.length}</strong></div>
        <div className="item"><span>Customers paid</span><span>{pounds(sales)}</span></div>
        <div className="item total"><strong>BiteBY fees</strong><strong>{pounds(fees)}</strong></div>
        <p className="muted small">From the latest 500 orders.</p>
      </div>
      <div className="segmented">
        {FILTERS.map((f) => (
          <label key={f.key} className={filter === f.key ? 'on not_present' : ''}>
            <input type="radio" checked={filter === f.key} onChange={() => setFilter(f.key)} />
            {f.label}
          </label>
        ))}
      </div>
      {shown.length === 0 && <p className="muted">No orders here.</p>}
      {shown.map((o) => <AdminOrderCard key={o.id} order={o} onChanged={load} />)}
    </div>
  )
}

function AdminOrderCard({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const canCancel = order.status === 'awaiting_payment' || order.status === 'pending_acceptance'

  async function cancel() {
    const { error } = await supabase!.rpc('admin_cancel_order', { p_order: order.id, p_reason: reason })
    if (error) return setMessage(error.message)
    onChanged()
  }

  return (
    <article className="card">
      <div className="item">
        <strong>{order.code} · {order.shops?.name ?? 'Shop'}</strong>
        <span className="pill">{ORDER_STATUS[order.status]}</span>
      </div>
      <p className="muted small">
        {order.customer_name} · {order.fulfilment} · {when(order.created_at)} · {pounds(order.total_pence)} (fee {pounds(order.platform_fee_pence)})
      </p>
      {order.decline_reason && <p className="small">Reason: {order.decline_reason}</p>}
      {canCancel && !open && <button className="secondary small-btn" onClick={() => setOpen(true)}>Cancel order</button>}
      {open && (
        <>
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason (the customer sees this)" />
          <div className="row">
            <button onClick={cancel} disabled={!reason.trim()}>Cancel order</button>
            <button className="secondary" onClick={() => setOpen(false)}>Back</button>
          </div>
        </>
      )}
      {message && <p className="error">{message}</p>}
    </article>
  )
}

// All reviews, so anything abusive can be hidden.
export function AdminReviews() {
  const [reviews, setReviews] = useState<(Review & { shops?: { name: string; slug: string } })[] | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase!.from('reviews').select('*, shops(name, slug)').order('created_at', { ascending: false }).limit(300)
    setReviews(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!reviews) return <p className="muted">Loading…</p>
  return (
    <div className="stack">
      {reviews.length === 0 && <p className="muted">No reviews yet.</p>}
      {reviews.map((r) => <AdminReviewCard key={r.id} review={r} onChanged={load} />)}
    </div>
  )
}

function AdminReviewCard({ review, onChanged }: { review: Review & { shops?: { name: string; slug: string } }; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [message, setMessage] = useState('')

  async function setHidden(hidden: boolean) {
    const { error } = await supabase!.rpc('admin_hide_review', { p_review: review.id, p_hidden: hidden, p_reason: reason || null })
    if (error) return setMessage(error.message)
    onChanged()
  }

  return (
    <div className="card">
      {review.shops && (
        <p className="small">For <a href={`/s/${review.shops.slug}`} onClick={link(`/s/${review.shops.slug}`)}>{review.shops.name}</a></p>
      )}
      <ReviewItem review={review}>
        {review.hidden ? (
          <>
            <p className="error small">Hidden: {review.hidden_reason}</p>
            <button className="secondary small-btn" onClick={() => setHidden(false)}>Show again</button>
          </>
        ) : (
          <div className="row">
            <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Reason for hiding" />
            <button className="secondary small-btn" disabled={!reason.trim()} onClick={() => setHidden(true)}>Hide</button>
          </div>
        )}
      </ReviewItem>
      {message && <p className="error">{message}</p>}
    </div>
  )
}

type Overview = {
  users: number; new_users_7d: number; sellers: Record<string, number>; live_shops: number; dishes_on_sale: number
  orders_7d: number; orders_30d: number; sales_30d_pence: number; fees_30d_pence: number; open_orders: number
  reviews_30d: number; deletion_requests: number
}

// Platform numbers at a glance, and account deletions waiting to be finished.
export function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [deletions, setDeletions] = useState<{ user_id: string; email: string; requested_at: string }[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    supabase!.rpc('admin_overview').then(({ data: d, error: e }) => (e ? setError(e.message) : setData(d)))
    supabase!.rpc('admin_deletion_requests').then(({ data: d }) => setDeletions(d ?? []))
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  const waiting = (data.sellers.submitted ?? 0) + (data.sellers.in_review ?? 0)
  const tiles: [string, string | number][] = [
    ['People signed up', data.users],
    ['New this week', data.new_users_7d],
    ['Sellers to check', waiting],
    ['Approved sellers', data.sellers.approved ?? 0],
    ['Live shops', data.live_shops],
    ['Dishes on sale', data.dishes_on_sale],
    ['Orders in progress', data.open_orders],
    ['Paid orders, 7 days', data.orders_7d],
    ['Paid orders, 30 days', data.orders_30d],
    ['Sales, 30 days', pounds(data.sales_30d_pence)],
    ['BiteBY fees, 30 days', pounds(data.fees_30d_pence)],
    ['Reviews, 30 days', data.reviews_30d],
  ]
  return (
    <div className="stack">
      <div className="grid2">
        {tiles.map(([label, value]) => (
          <div key={label} className="card" style={{ gap: 2 }}>
            <strong style={{ fontSize: '1.4rem' }}>{value}</strong>
            <span className="muted tiny">{label}</span>
          </div>
        ))}
      </div>
      {deletions.length > 0 && (
        <div className="card">
          <h2>Accounts to remove</h2>
          <p className="muted small">
            These people deleted their account. Their personal details are already wiped. To finish, remove their sign-in:
            in Supabase open Authentication, then Users, search for the email, and choose Delete user. It disappears from this list after that.
          </p>
          {deletions.map((d) => (
            <div key={d.user_id} className="item"><span>{d.email}</span><span className="muted small">{when(d.requested_at)}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}
