import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { tidyOrders } from '../lib/alerts'
import { link } from '../lib/router'
import { pounds } from '../lib/types'
import { ReviewForm, ReviewItem, type Review } from '../lib/reviews'

export type OrderStatus =
  | 'awaiting_payment' | 'pending_acceptance' | 'accepted' | 'declined' | 'ready'
  | 'out_for_delivery' | 'completed' | 'cancelled' | 'expired' | 'refunded'

export type Order = {
  id: string
  code: string
  shop_id: string
  status: OrderStatus
  fulfilment: 'collection' | 'delivery'
  requested_for: string | null
  customer_name: string
  customer_phone: string | null
  customer_note: string | null
  delivery_address: string | null
  delivery_postcode: string | null
  subtotal_pence: number
  delivery_fee_pence: number
  total_pence: number
  platform_fee_pence: number
  decline_reason: string | null
  created_at: string
  shops?: { name: string; slug: string }
}

export type OrderItem = { id: string; name: string; qty: number; unit_price_pence: number; line_total_pence: number; contains: string[]; may_contain: string[] }

export const ORDER_STATUS: Record<OrderStatus, string> = {
  awaiting_payment: 'Waiting for payment',
  pending_acceptance: 'Waiting for the cook to accept',
  accepted: 'Accepted, being made',
  declined: 'Declined',
  ready: 'Ready',
  out_for_delivery: 'On its way',
  completed: 'Done',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
}

export function when(iso: string | null) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// The customer's orders.
export function MyOrders() {
  const [orders, setOrders] = useState<Order[] | null>(null)

  useEffect(() => {
    tidyOrders()
    ;(async () => {
      const { data: user } = await supabase!.auth.getUser()
      const { data } = await supabase!
        .from('orders')
        .select('*, shops(name, slug)')
        .eq('customer_id', user.user!.id)
        .order('created_at', { ascending: false })
        .limit(50)
      setOrders(data ?? [])
    })()
  }, [])

  if (!orders) return <p className="muted">Loading…</p>
  return (
    <div className="stack">
      <h1>Your orders</h1>
      {orders.length === 0 && <p className="muted">No orders yet.</p>}
      {orders.map((o) => (
        <a key={o.id} className="card item" href={`/orders/${o.id}`} onClick={link(`/orders/${o.id}`)}>
          <div>
            <strong>{o.shops?.name}</strong>
            <div className="muted small">{when(o.created_at)} · {pounds(o.total_pence)}</div>
          </div>
          <span className="pill">{ORDER_STATUS[o.status]}</span>
        </a>
      ))}
    </div>
  )
}

type Collection = { address_line1: string | null; address_line2: string | null; city: string | null; postcode: string | null; collection_instructions: string | null; contact_phone: string | null }

export function OrderDetail({ id }: { id: string }) {
  const [order, setOrder] = useState<Order | null | undefined>(undefined)
  const [items, setItems] = useState<OrderItem[]>([])
  const [collection, setCollection] = useState<Collection | null>(null)
  const [allergenNames, setAllergenNames] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  const [review, setReview] = useState<Review | null>(null)

  const load = useCallback(async () => {
    const db = supabase!
    const { data: r } = await db.from('reviews').select('*').eq('order_id', id).maybeSingle()
    setReview(r)
    const [o, i, a] = await Promise.all([
      db.from('orders').select('*, shops(name, slug)').eq('id', id).maybeSingle(),
      db.from('order_items').select('*').eq('order_id', id),
      db.from('allergens').select('code, name'),
    ])
    setOrder(o.data)
    setItems(i.data ?? [])
    setAllergenNames(Object.fromEntries((a.data ?? []).map((x) => [x.code, x.name])))
    if (o.data && ['accepted', 'ready', 'out_for_delivery', 'completed'].includes(o.data.status) && o.data.fulfilment === 'collection') {
      const { data } = await db.rpc('order_collection_details', { p_order: id })
      setCollection(data?.[0] ?? null)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load])

  async function cancel() {
    const { error } = await supabase!.rpc('cancel_unpaid_order', { p_order: id })
    if (error) setMessage(error.message)
    else load()
  }

  if (order === undefined) return <p className="muted">Loading…</p>
  if (!order) return <p className="card">Order not found.</p>

  return (
    <div className="stack">
      <p><a href="/orders" onClick={link('/orders')}>← Your orders</a></p>
      <h1>Order {order.code}</h1>
      <p className="status">{ORDER_STATUS[order.status]}{order.decline_reason && `: ${order.decline_reason}`}</p>

      {order.status === 'awaiting_payment' && (
        <div className="card">
          <h2>Payment</h2>
          <p className="muted">
            Online payment is being switched on. Your order has been saved but hasn't been sent to
            the cook yet, and you haven't been charged.
          </p>
          <button className="secondary" onClick={cancel}>Cancel this order</button>
          {message && <p className="error">{message}</p>}
        </div>
      )}

      <div className="card">
        <p className="small">
          From <a href={`/s/${order.shops?.slug}`} onClick={link(`/s/${order.shops?.slug}`)}>{order.shops?.name}</a> ·{' '}
          {order.fulfilment === 'collection' ? 'Collection' : 'Delivery'}
          {order.requested_for && ` · for ${when(order.requested_for)}`}
        </p>
        {items.map((i) => (
          <div key={i.id}>
            <div className="item"><span>{i.qty} × {i.name}</span><span>{pounds(i.line_total_pence)}</span></div>
            {i.contains.length > 0 && <p className="muted small">Contains: {i.contains.map((c) => allergenNames[c] ?? c).join(', ')}</p>}
            {i.may_contain.length > 0 && <p className="muted small">May contain: {i.may_contain.map((c) => allergenNames[c] ?? c).join(', ')}</p>}
          </div>
        ))}
        {order.delivery_fee_pence > 0 && <div className="item"><span>Delivery</span><span>{pounds(order.delivery_fee_pence)}</span></div>}
        <div className="item"><strong>Total</strong><strong>{pounds(order.total_pence)}</strong></div>
      </div>

      {order.status === 'completed' && (review ? (
        <div className="card">
          <h2>Your review</h2>
          <ReviewItem review={review} />
        </div>
      ) : (
        <ReviewForm orderId={order.id} onDone={load} />
      ))}

      {collection && (
        <div className="card">
          <h2>Where to collect</h2>
          <p className="story">{[collection.address_line1, collection.address_line2, collection.city, collection.postcode].filter(Boolean).join('\n')}</p>
          {collection.collection_instructions && <p className="muted">{collection.collection_instructions}</p>}
          {collection.contact_phone && <p>Phone: <a href={`tel:${collection.contact_phone}`}>{collection.contact_phone}</a></p>}
        </div>
      )}
    </div>
  )
}
