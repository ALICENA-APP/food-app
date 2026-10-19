import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { pounds } from '../lib/types'
import { ReviewItem, Stars, type Review } from '../lib/reviews'

async function myShopIds() {
  const db = supabase!
  const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
  if (!account) return []
  const { data } = await db.from('shops').select('id').eq('seller_account_id', account.id)
  return (data ?? []).map((s) => s.id as string)
}

type Row = { subtotal_pence: number; discount_pence: number; delivery_fee_pence: number; platform_fee_pence: number; completed_at: string }

const PERIODS = [
  { key: 'week', label: 'Last 7 days', days: 7 },
  { key: 'month', label: 'Last 30 days', days: 30 },
  { key: 'all', label: 'All time', days: 0 },
] as const

// What the seller has earned from completed orders.
export function SellerEarnings() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('month')

  useEffect(() => {
    ;(async () => {
      const ids = await myShopIds()
      if (!ids.length) return setRows([])
      const { data } = await supabase!
        .from('orders')
        .select('subtotal_pence, discount_pence, delivery_fee_pence, platform_fee_pence, completed_at')
        .in('shop_id', ids)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(5000)
      setRows(data ?? [])
    })()
  }, [])

  if (!rows) return <p className="muted">Loading…</p>
  const days = PERIODS.find((p) => p.key === period)!.days
  const since = days ? Date.now() - days * 86400000 : 0
  const shown = rows.filter((r) => new Date(r.completed_at).getTime() >= since)
  const food = shown.reduce((n, r) => n + r.subtotal_pence, 0)
  const discounts = shown.reduce((n, r) => n + (r.discount_pence ?? 0), 0)
  const delivery = shown.reduce((n, r) => n + r.delivery_fee_pence, 0)
  const fees = shown.reduce((n, r) => n + r.platform_fee_pence, 0)

  return (
    <div className="stack">
      <p><a href="/sell" onClick={link('/sell')}>← Seller account</a></p>
      <h1>Earnings</h1>
      <div className="segmented">
        {PERIODS.map((p) => (
          <label key={p.key} className={period === p.key ? 'on not_present' : ''}>
            <input type="radio" checked={period === p.key} onChange={() => setPeriod(p.key)} />
            {p.label}
          </label>
        ))}
      </div>
      <div className="card">
        <div className="item"><span>Completed orders</span><strong>{shown.length}</strong></div>
        <div className="item"><span>Food sales</span><span>{pounds(food)}</span></div>
        {discounts > 0 && <div className="item"><span>Your discount codes</span><span>−{pounds(discounts)}</span></div>}
        <div className="item"><span>Delivery fees (all yours)</span><span>{pounds(delivery)}</span></div>
        <div className="item"><span>BiteBY fee (on food only)</span><span>−{pounds(fees)}</span></div>
        <div className="item total"><strong>You earned</strong><strong>{pounds(food - discounts + delivery - fees)}</strong></div>
      </div>
      <a className="tile report-tile" href="/sell/statement" onClick={link('/sell/statement')}>
        <span className="ic" style={{ background: 'var(--yellow-soft)' }}><Icon name="orders" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>Monthly statements</span>
          <span className="s">Every order, fee and earning by month, as a PDF or spreadsheet</span>
        </span>
      </a>
      <p className="muted small">Payouts go straight to your bank account through Stripe once payments are switched on. <a href="/fees" onClick={link('/fees')}>How fees work</a></p>
    </div>
  )
}

// Reviews of the seller's shop, with a reply box for each.
export function SellerReviews() {
  const [reviews, setReviews] = useState<Review[] | null>(null)

  const load = useCallback(async () => {
    const ids = await myShopIds()
    if (!ids.length) return setReviews([])
    const { data } = await supabase!.from('reviews').select('*').in('shop_id', ids).order('created_at', { ascending: false }).limit(200)
    setReviews(data ?? [])
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!reviews) return <p className="muted">Loading…</p>
  const visible = reviews.filter((r) => !r.hidden)
  const average = visible.length ? visible.reduce((n, r) => n + r.rating, 0) / visible.length : 0

  return (
    <div className="stack">
      <p><a href="/sell" onClick={link('/sell')}>← Seller account</a></p>
      <h1>Reviews</h1>
      {visible.length > 0 && <p><Stars value={average} /> {average.toFixed(1)} from {visible.length} {visible.length === 1 ? 'review' : 'reviews'}</p>}
      {reviews.length === 0 && <p className="muted">No reviews yet. Customers can review an order once it's complete.</p>}
      {reviews.map((r) => (
        <div key={r.id} className="card">
          <ReviewItem review={r}>
            {r.hidden && <p className="error small">Hidden by BiteBY: {r.hidden_reason}</p>}
            {!r.seller_reply && <ReplyBox reviewId={r.id} onDone={load} />}
          </ReviewItem>
        </div>
      ))}
    </div>
  )
}

function ReplyBox({ reviewId, onDone }: { reviewId: string; onDone: () => void }) {
  const [reply, setReply] = useState('')
  const [message, setMessage] = useState('')

  async function send() {
    const { error } = await supabase!.rpc('reply_to_review', { p_review: reviewId, p_reply: reply })
    if (error) return setMessage(error.message)
    onDone()
  }

  return (
    <>
      <textarea rows={2} maxLength={1000} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply publicly (you can reply once)" />
      <button type="button" className="secondary" disabled={!reply.trim()} onClick={send}>Post reply</button>
      {message && <p className="error">{message}</p>}
    </>
  )
}
