import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { tidyOrders } from '../lib/alerts'
import { link, queryParam } from '../lib/router'
import { OrderChat } from '../lib/chat'
import { pounds } from '../lib/types'
import { ORDER_STATUS, when, type Order, type OrderItem, type OrderStatus } from './Orders'

const OPEN: OrderStatus[] = ['pending_acceptance', 'accepted', 'ready', 'out_for_delivery']

// The seller's order inbox. Only paid orders appear here.
export default function SellerOrders() {
  const [orders, setOrders] = useState<(Order & { order_items: OrderItem[] })[] | null>(null)
  const [tab, setTab] = useState<'open' | 'past'>('open')
  const openId = queryParam('open')

  const load = useCallback(async () => {
    tidyOrders()
    const db = supabase!
    const { data: account } = await db.from('seller_accounts').select('id').maybeSingle()
    if (!account) return setOrders([])
    const { data: shops } = await db.from('shops').select('id').eq('seller_account_id', account.id)
    const ids = (shops ?? []).map((s) => s.id)
    if (!ids.length) return setOrders([])
    const { data } = await db
      .from('orders')
      .select('*, order_items(*)')
      .in('shop_id', ids)
      .neq('status', 'awaiting_payment')
      .order('created_at', { ascending: false })
      .limit(100)
    setOrders(data ?? [])
  }, [])

  // Coming from a message alert: show the tab that order is on, then scroll to it.
  const jumped = useRef(false)
  useEffect(() => {
    const target = orders?.find((o) => o.id === openId)
    if (!target || jumped.current) return
    jumped.current = true
    if (!OPEN.includes(target.status)) setTab('past')
    setTimeout(() => document.getElementById(`order-${target.id}`)?.scrollIntoView({ block: 'start' }), 50)
  }, [orders, openId])

  useEffect(() => {
    load()
    // New orders also arrive as alerts; this keeps the list itself fresh.
    const timer = window.setInterval(load, 60000)
    window.addEventListener('alerts-read', load)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('alerts-read', load)
    }
  }, [load])

  if (!orders) return <p className="muted">Loading…</p>
  const shown = orders.filter((o) => (tab === 'open') === OPEN.includes(o.status))

  return (
    <div className="stack">
      <p><a href="/sell" onClick={link('/sell')}>← Seller account</a></p>
      <h1>Orders</h1>
      <div className="segmented">
        <label className={tab === 'open' ? 'on not_present' : ''}>
          <input type="radio" checked={tab === 'open'} onChange={() => setTab('open')} />
          To do ({orders.filter((o) => OPEN.includes(o.status)).length})
        </label>
        <label className={tab === 'past' ? 'on not_present' : ''}>
          <input type="radio" checked={tab === 'past'} onChange={() => setTab('past')} />
          Past
        </label>
      </div>
      {shown.length === 0 && <p className="muted">No orders here yet.</p>}
      {shown.map((o) => <SellerOrderCard key={o.id} order={o} onChanged={load} />)}
    </div>
  )
}

function SellerOrderCard({ order, onChanged }: { order: Order & { order_items: OrderItem[] }; onChanged: () => void }) {
  const [reason, setReason] = useState('')
  const [declining, setDeclining] = useState(false)
  const [message, setMessage] = useState('')
  const [chat, setChat] = useState(() => queryParam('open') === order.id)

  async function move(status: OrderStatus) {
    const { error } = await supabase!.rpc('seller_update_order', { p_order: order.id, p_status: status, p_reason: reason || null })
    if (error) return setMessage(error.message)
    onChanged()
  }

  const yourShare = order.subtotal_pence - order.platform_fee_pence + order.delivery_fee_pence

  return (
    <article className="card" id={`order-${order.id}`}>
      <div className="item">
        <strong>{order.code} · {order.customer_name}</strong>
        <span className="pill">{ORDER_STATUS[order.status]}</span>
      </div>
      <p className="muted small">
        {order.fulfilment === 'collection' ? 'Collection' : 'Delivery'}
        {order.requested_for ? ` for ${when(order.requested_for)}` : ' as soon as possible'} · ordered {when(order.created_at)}
      </p>
      {order.order_items.map((i) => (
        <div key={i.id} className="item"><span>{i.qty} × {i.name}</span><span>{pounds(i.line_total_pence)}</span></div>
      ))}
      {order.delivery_address && <p className="small story">{order.delivery_address}{'\n'}{order.delivery_postcode}</p>}
      {order.customer_note && <p className="small"><strong>Note:</strong> {order.customer_note}</p>}
      {order.customer_phone && <p className="small">Phone: <a href={`tel:${order.customer_phone}`}>{order.customer_phone}</a></p>}
      <p className="muted small">Customer paid {pounds(order.total_pence)} · you get {pounds(yourShare)}</p>

      {order.status === 'pending_acceptance' && !declining && (
        <div className="row">
          <button onClick={() => move('accepted')}>Accept</button>
          <button className="secondary" onClick={() => setDeclining(true)}>Decline</button>
        </div>
      )}
      {declining && (
        <>
          <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Why? The customer will see this" />
          <div className="row">
            <button onClick={() => move('declined')}>Decline and refund</button>
            <button className="secondary" onClick={() => setDeclining(false)}>Back</button>
          </div>
        </>
      )}
      {order.status === 'accepted' && (
        <div className="row">
          <button onClick={() => move(order.fulfilment === 'delivery' ? 'out_for_delivery' : 'ready')}>
            {order.fulfilment === 'delivery' ? 'On its way' : 'Ready to collect'}
          </button>
        </div>
      )}
      {(order.status === 'ready' || order.status === 'out_for_delivery') && (
        <button onClick={() => move('completed')}>{order.fulfilment === 'delivery' ? 'Delivered' : 'Collected'}</button>
      )}
      {message && <p className="error">{message}</p>}
      <button type="button" className="secondary small-btn" onClick={() => setChat(!chat)}>
        {chat ? 'Hide messages' : `Message ${order.customer_name}`}
      </button>
      {chat && <OrderChat orderId={order.id} asSeller otherName={order.customer_name} />}
    </article>
  )
}
