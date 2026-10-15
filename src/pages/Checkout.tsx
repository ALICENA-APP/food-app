import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { basketSubtotal, setQty, useBasket, writeBasket } from '../lib/basket'
import { pounds, type ShopSettings } from '../lib/types'

type Zone = { name: string; postcode_districts: string[]; fee_pence: number; min_order_pence: number }

export default function Checkout() {
  const basket = useBasket()
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [fulfilment, setFulfilment] = useState<'collection' | 'delivery'>('collection')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [postcode, setPostcode] = useState('')
  const [when, setWhen] = useState('')
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')
  const [placing, setPlacing] = useState(false)
  const shopId = basket?.shopId

  useEffect(() => {
    if (!shopId) return
    const db = supabase!
    db.from('shop_settings').select('*').eq('shop_id', shopId).maybeSingle().then(({ data }) => {
      setSettings(data)
      if (data && !data.offers_collection) setFulfilment('delivery')
    })
    db.from('shop_delivery_zones').select('name, postcode_districts, fee_pence, min_order_pence').eq('shop_id', shopId).then(({ data }) => setZones(data ?? []))
  }, [shopId])

  if (!basket || basket.lines.length === 0) {
    return (
      <div className="card">
        <p>Your basket is empty.</p>
        <a className="button" href="/" onClick={link('/')}>Find food</a>
      </div>
    )
  }

  const subtotal = basketSubtotal(basket)
  const district = postcode.trim().toUpperCase().split(/\s+/)[0]
  const zone = fulfilment === 'delivery' && district
    ? zones.filter((z) => z.postcode_districts.includes(district)).sort((a, b) => a.fee_pence - b.fee_pence)[0]
    : undefined
  const fee = zone?.fee_pence ?? 0
  const shop = { id: basket.shopId, slug: basket.shopSlug, name: basket.shopName }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    setPlacing(true)
    const { data, error } = await supabase!.rpc('place_order', {
      p_shop: basket!.shopId,
      p_items: basket!.lines.map((l) => ({ product_id: l.productId, qty: l.qty })),
      p_fulfilment: fulfilment,
      p_customer_name: name,
      p_customer_phone: phone || null,
      p_note: note || null,
      p_requested_for: when ? new Date(when).toISOString() : null,
      p_delivery_address: fulfilment === 'delivery' ? address : null,
      p_delivery_postcode: fulfilment === 'delivery' ? postcode : null,
    })
    setPlacing(false)
    if (error) return setMessage(error.message)
    writeBasket(null)
    navigate(`/orders/${data}`)
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <p>
        <a href={`/s/${basket.shopSlug}`} onClick={link(`/s/${basket.shopSlug}`)}>← {basket.shopName}</a>
      </p>
      <h1>Your basket</h1>

      <div className="card">
        {basket.lines.map((l) => (
          <div key={l.productId} className="item">
            <span>{l.name}</span>
            <span className="qty">
              <button type="button" className="secondary small-btn" aria-label="One less" onClick={() => setQty(shop, l, l.qty - 1)}>−</button>
              <span>{l.qty}</span>
              <button type="button" className="secondary small-btn" aria-label="One more" onClick={() => setQty(shop, l, l.qty + 1)}>+</button>
              <span className="price">{pounds(l.qty * l.pricePence)}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="card">
        <h2>Collection or delivery</h2>
        {settings?.offers_collection !== false && (
          <label className="check">
            <input type="radio" name="fulfilment" checked={fulfilment === 'collection'} onChange={() => setFulfilment('collection')} />
            I'll collect it (you'll get the address once the cook accepts)
          </label>
        )}
        {settings?.offers_delivery && (
          <label className="check">
            <input type="radio" name="fulfilment" checked={fulfilment === 'delivery'} onChange={() => setFulfilment('delivery')} />
            Deliver to me
          </label>
        )}
        {fulfilment === 'delivery' && (
          <>
            <label>
              Address
              <textarea required rows={2} maxLength={300} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="street-address" />
            </label>
            <label>
              Postcode
              <input required maxLength={10} value={postcode} onChange={(e) => setPostcode(e.target.value)} autoComplete="postal-code" />
            </label>
            {district && !zone && <p className="error">This cook doesn't deliver to {district}.</p>}
          </>
        )}
        <label>
          When would you like it? (optional)
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
      </div>

      <div className="card">
        <h2>Your details</h2>
        <label>
          Name
          <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label>
          Phone (so the cook can reach you)
          <input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
        </label>
        <label>
          Note for the cook (optional)
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Allergies, timing, anything else" />
        </label>
      </div>

      <div className="card">
        <div className="item"><span>Food</span><span>{pounds(subtotal)}</span></div>
        {fulfilment === 'delivery' && <div className="item"><span>Delivery</span><span>{zone ? pounds(fee) : '–'}</span></div>}
        <div className="item"><strong>Total</strong><strong>{pounds(subtotal + fee)}</strong></div>
        <button type="submit" disabled={placing}>{placing ? 'Placing order…' : 'Place order'}</button>
        <p className="muted small">You pay before the cook starts. If they can't take your order, you get your money back.</p>
        {message && <p className="error">{message}</p>}
      </div>
    </form>
  )
}
