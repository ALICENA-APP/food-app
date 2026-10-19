import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { pounds } from '../lib/types'
import { ReviewItem, type Review } from '../lib/reviews'
import { TOPIC_LABEL, type Topic } from '../lib/help'
import { loadPlatform, percent } from '../lib/platform'
import { ORDER_STATUS, when, type Order, type OrderStatus } from './Orders'
import { Countdown, FeaturedBar, isBooked, moment } from '../lib/featured'

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
  reviews_30d: number; deletion_requests: number; open_help?: number
}

// Platform numbers at a glance, and account deletions waiting to be finished.
export function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [deletions, setDeletions] = useState<{ user_id: string; email: string; requested_at: string }[]>([])
  const [error, setError] = useState('')
  const [hygieneToCheck, setHygieneToCheck] = useState(0)

  useEffect(() => {
    supabase!.rpc('admin_overview').then(({ data: d, error: e }) => (e ? setError(e.message) : setData(d)))
    supabase!.rpc('admin_deletion_requests').then(({ data: d }) => setDeletions(d ?? []))
    supabase!.from('seller_verifications').select('id', { count: 'exact', head: true }).eq('kind', 'hygiene_rating').eq('status', 'pending')
      .then(({ count }) => setHygieneToCheck(count ?? 0))
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
    ['Help requests to answer', data.open_help ?? 0],
    ['Hygiene ratings to check', hygieneToCheck],
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
      <DailyCharts />
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
      <Waitlist />
      <DemoData />
    </div>
  )
}

type DayStat = { day: string; orders: number; sales_pence: number; fees_pence: number; new_users: number; new_sellers: number }

// Simple bar charts for the last 30 days.
function DailyCharts() {
  const [days, setDays] = useState<DayStat[] | null>(null)
  useEffect(() => {
    supabase!.rpc('admin_daily_stats', { p_days: 30 }).then(({ data }) => setDays((data ?? []) as DayStat[]))
  }, [])
  if (!days?.length) return null
  const short = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const charts: { title: string; total: string; values: number[] }[] = [
    { title: 'Paid orders', total: String(days.reduce((n, d) => n + d.orders, 0)), values: days.map((d) => d.orders) },
    { title: 'Sales', total: pounds(days.reduce((n, d) => n + Number(d.sales_pence), 0)), values: days.map((d) => Number(d.sales_pence)) },
    { title: 'BiteBY fees', total: pounds(days.reduce((n, d) => n + Number(d.fees_pence), 0)), values: days.map((d) => Number(d.fees_pence)) },
    { title: 'New sign-ups', total: String(days.reduce((n, d) => n + d.new_users, 0)), values: days.map((d) => d.new_users) },
    { title: 'New seller applications', total: String(days.reduce((n, d) => n + d.new_sellers, 0)), values: days.map((d) => d.new_sellers) },
  ]
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Last 30 days</h2>
      {charts.map((c) => {
        const max = Math.max(1, ...c.values)
        return (
          <div key={c.title} className="stack" style={{ gap: 4 }}>
            <div className="item"><span className="small">{c.title}</span><strong>{c.total}</strong></div>
            <div className="bars" role="img" aria-label={`${c.title} per day`}>
              {c.values.map((v, i) => <span key={days[i].day} className={v ? '' : 'zero'} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} title={`${short(days[i].day)}: ${c.title === 'Sales' || c.title === 'BiteBY fees' ? pounds(v) : v}`} />)}
            </div>
            <div className="bars-axis muted tiny"><span>{short(days[0].day)}</span><span>Today</span></div>
          </div>
        )
      })}
      <p className="muted tiny">Includes the demo shops’ made-up orders until you remove them.</p>
    </div>
  )
}

type WaitArea = { district: string; waiting: number; total: number; latest: string }

// Postcode areas where people want cooks: where to find sellers next.
function Waitlist() {
  const [areas, setAreas] = useState<WaitArea[] | null>(null)
  useEffect(() => {
    supabase!.rpc('admin_waitlist').then(({ data }) => setAreas(data ?? []))
  }, [])
  if (!areas) return null
  return (
    <div className="card stack" style={{ gap: 6 }}>
      <h2>Waiting for cooks</h2>
      <p className="muted small">People who tapped “Notify me” because there are no cooks near them yet. They get a notification when a shop opens in their area.</p>
      {areas.length === 0 && <p className="muted small">Nobody yet.</p>}
      {areas.slice(0, 20).map((a) => (
        <div key={a.district} className="item">
          <strong>{a.district}</strong>
          <span className="small">{a.waiting} waiting{a.total > a.waiting ? ` · ${a.total - a.waiting} already told` : ''}</span>
        </div>
      ))}
    </div>
  )
}

type Announcement = { id: number; audience: string; title: string; body: string | null; link: string | null; recipients: number; created_at: string }
const AUDIENCE: Record<string, string> = { everyone: 'Everyone', customers: 'Customers', cooks: 'Cooks' }

// Send a notification to everyone, all customers or all cooks.
export function AdminAnnounce() {
  const [audience, setAudience] = useState('everyone')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [linkTo, setLinkTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState<Announcement[]>([])

  const load = useCallback(() => {
    supabase!.from('announcements').select('*').order('created_at', { ascending: false }).limit(20).then(({ data }) => setSent(data ?? []))
  }, [])
  useEffect(() => { load() }, [load])

  async function send(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    if (!confirm(`Send “${title.trim()}” to ${AUDIENCE[audience].toLowerCase()}? Everyone in that group gets a notification.`)) return
    setBusy(true)
    const { data, error } = await supabase!.rpc('admin_announce', { p_audience: audience, p_title: title, p_body: body || null, p_link: linkTo || null })
    setBusy(false)
    if (error) return setMessage(error.message)
    setMessage(`Sent to ${data} ${data === 1 ? 'person' : 'people'}.`)
    setTitle('')
    setBody('')
    setLinkTo('')
    load()
  }

  return (
    <div className="stack">
      <form className="card stack" onSubmit={send}>
        <p className="muted small">Shows in people’s notifications (the bell) and as a pop-up if they have alerts on. Up to 5 a day.</p>
        <div className="segmented">
          {Object.entries(AUDIENCE).map(([k, v]) => (
            <label key={k} className={audience === k ? 'on not_present' : ''}>
              <input type="radio" checked={audience === k} onChange={() => setAudience(k)} /> {v}
            </label>
          ))}
        </div>
        <label>Title<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required placeholder="e.g. Discount codes are here" /></label>
        <label>Message (optional)<textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={300} /></label>
        <label>
          Page to open (optional)
          <select value={linkTo} onChange={(e) => setLinkTo(e.target.value)}>
            <option value="">Notifications</option>
            <option value="/">Home</option>
            <option value="/explore">Explore</option>
            <option value="/sell">Seller dashboard</option>
            <option value="/sell/discounts">Discount codes</option>
            <option value="/help">Help</option>
          </select>
        </label>
        <button type="submit" disabled={busy || title.trim().length < 3}>{busy ? 'Sending…' : 'Send announcement'}</button>
        {message && <p className={message.startsWith('Sent') ? 'tick small' : 'error small'}>{message}</p>}
      </form>
      {sent.length > 0 && <h2>Sent</h2>}
      {sent.map((a) => (
        <div key={a.id} className="card stack" style={{ gap: 4 }}>
          <div className="item"><strong>{a.title}</strong><span className="tag grey">{AUDIENCE[a.audience]}</span></div>
          {a.body && <p className="small">{a.body}</p>}
          <p className="muted tiny">{when(a.created_at)} · {a.recipients} {a.recipients === 1 ? 'person' : 'people'}</p>
        </div>
      ))}
    </div>
  )
}

type AdminHelp = {
  id: string; topic: Topic; details: string; status: 'open' | 'resolved'; admin_reply: string | null
  created_at: string; resolved_at: string | null; email: string | null; name: string | null; is_seller: boolean
  order_id: string | null; order_code: string | null; order_status: OrderStatus | null; total_pence: number | null; shop_name: string | null
}

// Messages from customers and sellers, answered in the app.
export function AdminHelpInbox() {
  const [status, setStatus] = useState<'open' | 'resolved'>('open')
  const [list, setList] = useState<AdminHelp[] | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const { data, error: e } = await supabase!.rpc('admin_help_requests', { p_status: status })
    if (e) return setError(e.message)
    setList(data ?? [])
  }, [status])

  useEffect(() => {
    setList(null)
    load()
  }, [load])

  return (
    <div className="stack">
      <div className="segmented">
        <label className={status === 'open' ? 'on' : ''}><input type="radio" checked={status === 'open'} onChange={() => setStatus('open')} />To answer</label>
        <label className={status === 'resolved' ? 'on' : ''}><input type="radio" checked={status === 'resolved'} onChange={() => setStatus('resolved')} />Answered</label>
      </div>
      {error && <p className="error">{error}</p>}
      {list === null && !error && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">{status === 'open' ? 'Nothing waiting. Nice.' : 'No answered requests yet.'}</p>}
      {list?.map((h) => <HelpCard key={h.id} help={h} onDone={load} />)}
    </div>
  )
}

function HelpCard({ help: h, onDone }: { help: AdminHelp; onDone: () => void }) {
  const [reply, setReply] = useState('')
  const [message, setMessage] = useState('')

  async function send() {
    const { error } = await supabase!.rpc('admin_answer_help', { p_id: h.id, p_reply: reply })
    if (error) return setMessage(error.message)
    onDone()
  }

  return (
    <article className="card stack" style={{ gap: 6 }}>
      <div className="item">
        <strong>{TOPIC_LABEL[h.topic]}</strong>
        {h.is_seller && <span className="tag grey">Seller</span>}
      </div>
      <p className="muted small">{h.name || 'No name'} · {h.email ?? 'deleted account'} · {new Date(h.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</p>
      {h.order_code && (
        <p className="small">Order <strong>{h.order_code}</strong> · {h.shop_name} · {h.order_status ? ORDER_STATUS[h.order_status] : ''} · {pounds(h.total_pence ?? 0)}</p>
      )}
      <p className="story">{h.details}</p>
      {h.status === 'resolved' ? (
        <div className="bubble-reply"><strong className="small">Your reply</strong><p className="small">{h.admin_reply}</p></div>
      ) : (
        <>
          <textarea rows={3} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply to them (they get an alert in the app)" aria-label="Reply" />
          <button type="button" onClick={send} disabled={!reply.trim()}>Send reply and close</button>
          {h.email && <a className="small" href={`mailto:${h.email}`}>Or email them</a>}
        </>
      )}
      {message && <p className="error small">{message}</p>}
    </article>
  )
}

// The made-up demo shops: how many there are, and a button to remove them all.
function DemoData() {
  const [count, setCount] = useState<number | null>(null)
  const [testShop, setTestShop] = useState('')
  const [sure, setSure] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    supabase!.from('shops').select('id', { count: 'exact', head: true }).eq('is_demo', true).then(({ count: n }) => setCount(n ?? 0))
    supabase!.from('shops').select('name').eq('is_test', true).limit(1).then(({ data }) => setTestShop(data?.[0]?.name ?? ''))
  }, [])

  if (!count && !testShop && !message) return null

  async function remove() {
    const { data, error } = await supabase!.rpc('admin_remove_demo_data')
    if (error) return setMessage(error.message)
    setCount(0)
    setTestShop('')
    setMessage(`Removed ${data} demo shops, with their dishes, reviews and featured spots, and the test shop's sample data.`)
  }

  return (
    <div className="card">
      <h2>Demo shops</h2>
      {count || testShop ? (
        <>
          {count ? <p className="muted small">There are {count} made-up demo shops so you can try every part of the app. They’re labelled “Demo” and can’t take real orders. Remove them before launch.</p> : null}
          {testShop && <p className="muted small">{testShop} is a test shop: it has sample dishes, orders and reviews, and orders from it can be paid in test mode. Removing demo data also removes those samples and puts {testShop} back to draft until payments are set up.</p>}
          <button type="button" className={sure ? 'danger' : 'secondary'} onClick={() => (sure ? remove() : setSure(true))}>
            {sure ? 'Tap again to remove all demo shops' : 'Remove demo shops'}
          </button>
        </>
      ) : null}
      {message && <p className="small">{message}</p>}
    </div>
  )
}

type AdminPromo = {
  id: string; shop_name: string; slug: string; is_demo: boolean; weeks: number; status: string
  starts_at: string | null; ends_at: string | null; fee_pence: number; note: string | null; created_at: string; running: boolean
  next_start?: string | null; area_label: string | null; in_use_nearby: number
}

// Featured (sponsored) spots: requests to approve, and who is featured now.
export function AdminPromoted() {
  const [data, setData] = useState<{ slots: number; radius: number; week_pence: number; list: AdminPromo[] } | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const { data: d, error: e } = await supabase!.rpc('admin_promotions')
    if (e) return setError(e.message)
    setData(d)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function decide(id: string, action: 'approve' | 'decline' | 'end') {
    setError('')
    const note = action === 'decline' ? window.prompt('Reason to show the cook (optional)') ?? undefined : undefined
    const { error: e } = await supabase!.rpc('admin_decide_promotion', { p_id: id, p_action: action, p_note: note || null })
    if (e) return setError(e.message)
    load()
  }

  if (error && !data) return <p className="error">{error}</p>
  if (!data) return <p className="muted">Loading…</p>
  const requests = data.list.filter((p) => p.status === 'requested')
  const running = data.list.filter((p) => p.running).sort((a, b) => (a.ends_at ?? '').localeCompare(b.ends_at ?? ''))
  const booked = data.list.filter(isBooked).sort((a, b) => a.starts_at!.localeCompare(b.starts_at!))
  const startsNow = (iso: string | null | undefined) => !iso || new Date(iso).getTime() <= Date.now() + 60000
  // Waiting requests in the order they were sent: first come, first served.
  requests.sort((a, b) => a.created_at.localeCompare(b.created_at))

  return (
    <div className="stack">
      <div className="card">
        <div className="item"><span>Spots per area</span><strong>{data.slots} within {data.radius} miles</strong></div>
        <div className="item"><span>Featured now, UK-wide</span><strong>{running.length}</strong></div>
        <div className="item"><span>Price per week</span><strong>{pounds(data.week_pence)}</strong></div>
        <p className="muted small">Spots are local. A cook is only shown to customers within {data.radius} miles of them, and the {data.slots} spots are counted among cooks within {data.radius} miles of each other, so a cook in Manchester never takes a London spot.</p>
        <p className="muted small">A spot lasts exactly the weeks bought, to the minute. When the spots near a cook are full, approving books the moment one frees up, and the cook is told when they start.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <h2>Requests ({requests.length})</h2>
      {requests.length === 0 && <p className="muted">No requests waiting.</p>}
      {requests.map((p) => (
        <article key={p.id} className="card">
          <div className="item"><strong><a href={`/s/${p.slug}`} onClick={link(`/s/${p.slug}`)}>{p.shop_name}</a></strong><span>{p.weeks} {p.weeks === 1 ? 'week' : 'weeks'} · {pounds(p.fee_pence)}</span></div>
          <p className="muted tiny">{p.area_label && `${p.area_label} · `}{p.in_use_nearby} of {data.slots} spots in use nearby · asked {when(p.created_at)}</p>
          <div className="row">
            <button type="button" onClick={() => decide(p.id, 'approve')}>
              {startsNow(p.next_start) ? 'Approve, start now' : `Approve, start ${moment(p.next_start!)}`}
            </button>
            <button type="button" className="secondary" onClick={() => decide(p.id, 'decline')}>Decline</button>
          </div>
        </article>
      ))}
      <h2>Featured now</h2>
      {running.length === 0 && <p className="muted">Nobody is featured right now.</p>}
      {running.map((p) => (
        <article key={p.id} className="card stack" style={{ gap: 8 }}>
          <div className="item">
            <strong>{p.shop_name} {p.is_demo && <span className="tag demo">Demo</span>}</strong>
            <strong className="small"><Countdown end={p.ends_at!} /></strong>
          </div>
          <FeaturedBar start={p.starts_at!} end={p.ends_at!} />
          <p className="muted tiny">{p.area_label && `${p.area_label} · `}{p.weeks} {p.weeks === 1 ? 'week' : 'weeks'} · ends {moment(p.ends_at!)}</p>
          <button type="button" className="secondary small-btn" onClick={() => decide(p.id, 'end')}>End early</button>
        </article>
      ))}
      {booked.length > 0 && <h2>Booked next</h2>}
      {booked.map((p) => (
        <article key={p.id} className="card stack" style={{ gap: 8 }}>
          <div className="item">
            <strong>{p.shop_name} {p.is_demo && <span className="tag demo">Demo</span>}</strong>
            <strong className="small">Starts {moment(p.starts_at!)}</strong>
          </div>
          <p className="muted tiny">{p.area_label && `${p.area_label} · `}until {moment(p.ends_at!)} · {p.weeks} {p.weeks === 1 ? 'week' : 'weeks'}</p>
          <button type="button" className="secondary small-btn" onClick={() => decide(p.id, 'end')}>Cancel booking</button>
        </article>
      ))}
    </div>
  )
}

type Flag = {
  id: number; source: string; reason: string; excerpt: string | null; created_at: string; shop_id: string | null; shop_name: string | null
  slug: string | null; shop_status: ShopState | null; product_name: string | null; order_code: string | null; email: string | null; shop_total: number
}
type ShopState = 'draft' | 'live' | 'paused' | 'suspended'

const SHOP_STATE: Record<ShopState, string> = { draft: 'Not live yet', live: 'Live', paused: 'Paused', suspended: 'Suspended' }

// Pause, suspend or restore a shop. The cook gets a notification with the note.
function ShopActions({ shopId, status, onChanged }: { shopId: string; status: ShopState; onChanged: (s: ShopState) => void }) {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  async function set(next: ShopState) {
    if (next === 'suspended' && !note.trim()) return setError('Add a note saying why. The cook will see it.')
    if (next === 'suspended' && !confirm('Suspend this shop? It disappears from BiteBY and the cook can’t turn it back on.')) return
    setError('')
    const { error: e } = await supabase!.rpc('admin_set_shop_status', { p_shop: shopId, p_status: next, p_note: note.trim() || null })
    if (e) return setError(e.message)
    setNote('')
    setOpen(false)
    onChanged(next)
  }

  if (!open) {
    return (
      <div className="row wrap">
        {status === 'suspended'
          ? <button type="button" className="secondary small-btn" onClick={() => set('paused')}>Restore shop</button>
          : <button type="button" className="secondary small-btn" onClick={() => setOpen(true)}>Pause or suspend…</button>}
        {error && <p className="error small">{error}</p>}
      </div>
    )
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the cook (needed to suspend)" />
      <p className="muted tiny">Pause: the shop goes offline and the cook can turn it back on. Suspend: it stays offline until you restore it.</p>
      <div className="row wrap">
        {status === 'live' && <button type="button" className="secondary small-btn" onClick={() => set('paused')}>Pause shop</button>}
        <button type="button" className="danger-solid small-btn" onClick={() => set('suspended')}>Suspend shop</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  )
}

// Reports from customers, and attempts to move orders, payment or contact off BiteBY.
export function AdminSafety() {
  const [flags, setFlags] = useState<Flag[] | null>(null)
  const [error, setError] = useState('')
  const [only, setOnly] = useState<'all' | 'report'>('all')

  useEffect(() => {
    supabase!.rpc('admin_safety_flags').then(({ data, error: e }) => (e ? setError(e.message) : setFlags(data ?? [])))
  }, [])

  if (error) return <p className="error">{error}</p>
  if (!flags) return <p className="muted">Loading…</p>
  const shown = only === 'report' ? flags.filter((f) => f.source === 'report') : flags
  const setShopStatus = (shopId: string, s: ShopState) => setFlags((list) => list!.map((f) => (f.shop_id === shopId ? { ...f, shop_status: s } : f)))
  return (
    <div className="stack">
      <p className="muted small">
        Customer reports, plus messages with phone numbers, emails, links, bank details or talk of paying outside BiteBY (those messages are stopped automatically and never reach the other person, even when split up or spelt like C a $ h).
        Shop pages and dishes can’t be saved with them at all. A cook who keeps appearing here may be taking customers off the app.
      </p>
      <div className="chips">
        <button type="button" className={`chip ${only === 'all' ? 'on' : ''}`} onClick={() => setOnly('all')}>Everything ({flags.length})</button>
        <button type="button" className={`chip ${only === 'report' ? 'on' : ''}`} onClick={() => setOnly('report')}>Customer reports ({flags.filter((f) => f.source === 'report').length})</button>
      </div>
      {shown.length === 0 && <p className="muted">Nothing here. Good.</p>}
      {shown.map((f) => (
        <article key={f.id} className="card stack" style={{ gap: 4 }}>
          <div className="item">
            <strong>{f.slug ? <a href={`/s/${f.slug}`} onClick={link(`/s/${f.slug}`)}>{f.shop_name}</a> : f.shop_name ?? 'Unknown shop'}</strong>
            <span className={`tag ${f.shop_total >= 3 ? 'red' : 'grey'}`}>{f.shop_total} flagged</span>
          </div>
          <p className="small"><strong>{f.reason}</strong>{f.product_name ? ` · ${f.product_name}` : ''}</p>
          <p className="muted tiny">{f.source === 'report' ? 'customer report' : f.source}{f.order_code ? ` · order ${f.order_code}` : ''} · {f.email ?? ''} · {when(f.created_at)}{f.shop_status ? ` · shop ${SHOP_STATE[f.shop_status].toLowerCase()}` : ''}</p>
          {f.excerpt && <p className="story small">{f.excerpt}</p>}
          {f.shop_id && f.shop_status && <ShopActions shopId={f.shop_id} status={f.shop_status} onChanged={(s) => setShopStatus(f.shop_id!, s)} />}
        </article>
      ))}
    </div>
  )
}

type AdminShop = {
  id: string; name: string; slug: string; status: ShopState; accepting_orders: boolean; is_demo: boolean; area_label: string | null
  created_at: string; seller_status: string; email: string | null; orders: number; flags: number; reports: number
}

// Every shop, with a search, its state, and pause, suspend or restore.
export function AdminShops() {
  const [search, setSearch] = useState('')
  const [shops, setShops] = useState<AdminShop[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      supabase!.rpc('admin_shops', { p_search: search.trim() || null })
        .then(({ data, error: e }) => (e ? setError(e.message) : setShops(data ?? [])))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  if (error) return <p className="error">{error}</p>
  return (
    <div className="stack">
      <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by shop name, link or email" aria-label="Search shops" />
      {!shops && <p className="muted">Loading…</p>}
      {shops?.length === 0 && <p className="muted">No shops found.</p>}
      {shops?.map((s) => (
        <article key={s.id} className="card stack" style={{ gap: 4 }}>
          <div className="item">
            <strong><a href={`/s/${s.slug}`} onClick={link(`/s/${s.slug}`)}>{s.name}</a></strong>
            <span className={`tag ${s.status === 'live' ? 'green' : s.status === 'suspended' ? 'red' : 'grey'}`}>{SHOP_STATE[s.status]}</span>
          </div>
          <p className="muted tiny">
            {[s.area_label, s.email, s.is_demo && 'demo', `seller ${s.seller_status.replace('_', ' ')}`, s.status === 'live' && !s.accepting_orders && 'orders paused by cook'].filter(Boolean).join(' · ')}
          </p>
          <p className="small">{s.orders} paid {s.orders === 1 ? 'order' : 'orders'} · {s.reports} {s.reports === 1 ? 'report' : 'reports'} · {s.flags} flagged in total</p>
          <ShopActions shopId={s.id} status={s.status} onChanged={(next) => setShops((list) => list!.map((x) => (x.id === s.id ? { ...x, status: next } : x)))} />
          {!s.is_demo && <TestShopButton shopId={s.id} name={s.name} />}
        </article>
      ))}
    </div>
  )
}

// Fills a shop with sample dishes, orders and reviews, and lets orders from it
// be paid in test mode. Removed again with the demo data.
function TestShopButton({ shopId, name }: { shopId: string; name: string }) {
  const [sure, setSure] = useState(false)
  const [message, setMessage] = useState('')
  async function make() {
    const { error } = await supabase!.rpc('admin_make_test_shop', { p_shop: shopId })
    setSure(false)
    setMessage(error ? error.message : `${name} is now a test shop with sample dishes, orders and reviews.`)
  }
  return (
    <div className="stack" style={{ gap: 4 }}>
      <button type="button" className="link" style={{ alignSelf: 'flex-start' }} onClick={() => (sure ? make() : setSure(true))}>
        {sure ? `Tap again to fill ${name} with sample data` : 'Make this a test shop'}
      </button>
      {message && <p className="small">{message}</p>}
    </div>
  )
}

// Platform settings: commission and featured spots. Changes apply to new orders and requests.
export function AdminSettings() {
  const [commission, setCommission] = useState('')
  const [price, setPrice] = useState('')
  const [slots, setSlots] = useState('')
  const [radius, setRadius] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [sure, setSure] = useState(false)

  useEffect(() => {
    loadPlatform(true).then((s) => {
      setCommission(String(s.commission_bps / 100))
      setPrice((s.promo_week_pence / 100).toFixed(2))
      setSlots(String(s.promo_slots))
      setRadius(String(s.promo_radius_miles))
      setSaved(percent(s.commission_bps))
    })
  }, [])

  const bps = Math.round(parseFloat(commission || '0') * 100)
  const changed = saved !== null && percent(bps) !== saved

  async function save() {
    setMessage('')
    if (changed && !sure) return setSure(true)
    const { error } = await supabase!.rpc('admin_update_settings', {
      p_commission_bps: bps,
      p_promo_week_pence: Math.round(parseFloat(price || '0') * 100),
      p_promo_slots: parseInt(slots || '0', 10),
      p_promo_radius_miles: parseFloat(radius || '10'),
    })
    setSure(false)
    if (error) return setMessage(error.message)
    await loadPlatform(true)
    setSaved(percent(bps))
    setMessage('Saved. New orders and requests use these settings.')
  }

  if (saved === null) return <p className="muted">Loading…</p>
  return (
    <div className="card stack">
      <h2>Settings</h2>
      <label>
        BiteBY commission on food (%)
        <input type="number" min="0" max="30" step="0.5" inputMode="decimal" value={commission} onChange={(e) => { setCommission(e.target.value); setSure(false) }} />
      </label>
      <p className="muted small">Taken from the food price only, never from delivery fees. Orders already placed keep the rate they were placed at. The help text and seller terms update automatically.</p>
      <label>
        Featured spot price per week (£)
        <input type="number" min="0" max="1000" step="0.5" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      </label>
      <label>
        Featured spots per area
        <input type="number" min="0" max="50" step="1" inputMode="numeric" value={slots} onChange={(e) => setSlots(e.target.value)} />
      </label>
      <label>
        Featured area (miles)
        <input type="number" min="1" max="100" step="1" inputMode="decimal" value={radius} onChange={(e) => setRadius(e.target.value)} />
      </label>
      <p className="muted small">Featured cooks show to customers within this distance, and the spots above are shared by cooks within this distance of each other.</p>
      {sure && <p className="status small">You’re changing the commission from {saved} to {percent(bps)}. Your seller terms promise sellers 30 days’ notice of fee changes, so tell them first and save it when the notice ends. Tap Save again to confirm.</p>}
      <button type="button" onClick={save}>{sure ? 'Confirm and save' : 'Save settings'}</button>
      {message && <p className="small">{message}</p>}
    </div>
  )
}
