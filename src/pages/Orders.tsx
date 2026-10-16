import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { tidyOrders } from '../lib/alerts'
import { link, navigate } from '../lib/router'
import { Icon } from '../lib/icons'
import { readBasket, writeBasket } from '../lib/basket'
import { Avatar } from '../lib/ui'
import { OrderChat } from '../lib/chat'
import { HelpForm } from '../lib/help'
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
  shops?: { name: string; slug: string; logo_path?: string | null }
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

const ACTIVE: OrderStatus[] = ['awaiting_payment', 'pending_acceptance', 'accepted', 'ready', 'out_for_delivery']

// The progress tracker: placed, confirmed, being made, on its way / ready, done.
export function Tracker({ order }: { order: Pick<Order, 'status' | 'fulfilment'> }) {
  const delivery = order.fulfilment === 'delivery'
  const steps = ['Order placed', 'Confirmed by the cook', 'Being prepared', delivery ? 'Out for delivery' : 'Ready to collect', delivery ? 'Delivered' : 'Collected']
  const at: Partial<Record<OrderStatus, number>> = { awaiting_payment: 0, pending_acceptance: 1, accepted: 2, ready: 3, out_for_delivery: 3, completed: 5 }
  const progress = at[order.status]
  if (progress === undefined) return null
  return (
    <div className="timeline">
      {steps.map((label, i) => (
        <div key={label} className={`step ${i < progress ? 'done' : i === progress ? 'now' : ''}`}>
          <span className="dot">{i < progress && <Icon name="check" size={14} />}</span>
          <span className="label">{label}</span>
        </div>
      ))}
    </div>
  )
}

type OrderWithItems = Order & { order_items: Pick<OrderItem, 'id' | 'name' | 'qty'>[] }

// Puts the same dishes back in the basket at today's prices.
export async function reorder(order: Order) {
  const db = supabase!
  const { data: items } = await db.from('order_items').select('product_id, qty').eq('order_id', order.id)
  const ids = (items ?? []).map((i) => i.product_id).filter(Boolean) as string[]
  const { data: products } = ids.length
    ? await db.from('products').select('id, name, price_pence, status, product_images(path, sort)').in('id', ids).eq('status', 'published')
    : { data: [] }
  const lines = (items ?? []).flatMap((i) => {
    const p = (products ?? []).find((x) => x.id === i.product_id)
    if (!p) return []
    const photo = [...(p.product_images ?? [])].sort((a, b) => a.sort - b.sort)[0]?.path ?? null
    return [{ productId: p.id, name: p.name, pricePence: p.price_pence, qty: i.qty, photo }]
  })
  if (!lines.length) return window.alert('These dishes are no longer on the menu.')
  const current = readBasket()
  if (current && current.lines.length && current.shopId !== order.shop_id &&
      !window.confirm(`Your basket has food from ${current.shopName}. Replace it?`)) return
  writeBasket({ shopId: order.shop_id, shopSlug: order.shops?.slug ?? '', shopName: order.shops?.name ?? '', lines })
  navigate('/basket')
}

// The customer's orders: ones in progress with a tracker, then past orders.
export function MyOrders() {
  const [orders, setOrders] = useState<OrderWithItems[] | null>(null)

  useEffect(() => {
    tidyOrders()
    ;(async () => {
      const { data: user } = await supabase!.auth.getUser()
      const { data } = await supabase!
        .from('orders')
        .select('*, shops(name, slug, logo_path), order_items(id, name, qty)')
        .eq('customer_id', user.user!.id)
        .order('created_at', { ascending: false })
        .limit(50)
      setOrders(data ?? [])
    })()
  }, [])

  if (!orders) return <p className="muted">Loading…</p>
  const active = orders.filter((o) => ACTIVE.includes(o.status))
  const past = orders.filter((o) => !ACTIVE.includes(o.status))
  const summary = (o: OrderWithItems) => o.order_items.map((i) => `${i.qty} × ${i.name}`).join(', ')

  return (
    <div className="stack">
      <h1>Orders</h1>
      {orders.length === 0 && (
        <div className="card empty">
          <span className="big">🧾</span>
          <h2 style={{ color: 'var(--text)' }}>No orders yet</h2>
          <p>When you order, you can follow it here from the kitchen to your door.</p>
          <a className="button" href="/explore" onClick={link('/explore')}>Explore food</a>
        </div>
      )}
      {active.length > 0 && <h2>In progress</h2>}
      {active.map((o) => (
        <a key={o.id} className="card" href={`/orders/${o.id}`} onClick={link(`/orders/${o.id}`)} style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="order-row">
            <span className="ph"><Avatar name={o.shops?.name ?? '?'} path={o.shops?.logo_path} size={56} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{o.shops?.name}</strong>
              <span className="muted small" style={{ display: 'block' }}>{summary(o)}</span>
              <span className="muted tiny">Order {o.code} · {pounds(o.total_pence)}</span>
            </span>
          </div>
          <span className="pill yellow">{ORDER_STATUS[o.status]}</span>
          <Tracker order={o} />
        </a>
      ))}
      {past.length > 0 && <h2>Past orders</h2>}
      {past.map((o) => (
        <div key={o.id} className="card">
          <a className="order-row" href={`/orders/${o.id}`} onClick={link(`/orders/${o.id}`)}>
            <span className="ph"><Avatar name={o.shops?.name ?? '?'} path={o.shops?.logo_path} size={56} /></span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <strong>{o.shops?.name}</strong>
              <span className="muted small" style={{ display: 'block' }}>{summary(o)}</span>
              <span className="muted tiny">{when(o.created_at)} · {pounds(o.total_pence)}</span>
            </span>
            <span className={`pill ${o.status === 'completed' ? 'green' : ''}`}>{ORDER_STATUS[o.status]}</span>
          </a>
          <div className="row">
            <a className="button secondary small-btn" href={`/orders/${o.id}`} onClick={link(`/orders/${o.id}`)}>{o.status === 'completed' ? 'Receipt and review' : 'View details'}</a>
            <button type="button" className="small-btn" onClick={() => reorder(o)}>Reorder</button>
          </div>
        </div>
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
      <a className="back" href="/orders" onClick={link('/orders')}><Icon name="back" size={18} /> Orders</a>
      <h1>Order {order.code}</h1>
      <div className="card">
        <span className={`pill ${order.status === 'completed' ? 'green' : 'yellow'}`}>{ORDER_STATUS[order.status]}</span>
        {order.decline_reason && <p className="small">{order.decline_reason}</p>}
        <Tracker order={order} />
      </div>

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
        <div className="item total"><strong>Total</strong><strong>{pounds(order.total_pence)}</strong></div>
        <p className="muted tiny">Ordered {when(order.created_at)}</p>
      </div>

      {!ACTIVE.includes(order.status) && <button type="button" className="secondary" onClick={() => reorder(order)}>Order this again</button>}

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

      {order.status !== 'awaiting_payment' && (
        <div className="card" id="messages">
          <h2>Messages</h2>
          <OrderChat orderId={order.id} asSeller={false} otherName={order.shops?.name ?? 'the cook'} />
        </div>
      )}

      {order.status !== 'awaiting_payment' && (
        <details className="card" id="problem">
          <summary>Report a problem with this order</summary>
          <p className="muted small">Message the cook first if it’s something they can sort out. If not, tell the BiteBY team and we’ll help.</p>
          <HelpForm orderId={order.id} plain />
        </details>
      )}
    </div>
  )
}
