import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { askToSignIn, useSession } from '../lib/session'
import { Icon } from '../lib/icons'
import { basketCount, basketSubtotal, setQty, useBasket, writeBasket } from '../lib/basket'
import { FoodPhoto } from '../lib/ui'
import { loadAddresses, saveAddress, type SavedAddress } from './Addresses'
import { pounds, type ShopSettings } from '../lib/types'

type Zone = { name: string; postcode_districts: string[]; fee_pence: number; min_order_pence: number }
type Draft = { fulfilment: 'collection' | 'delivery'; name: string; phone: string; address: string; postcode: string; when: string; note: string }

const DRAFT_KEY = 'checkoutDraft'
const emptyDraft: Draft = { fulfilment: 'collection', name: '', phone: '', address: '', postcode: '', when: '', note: '' }

function readDraft(): Draft {
  try {
    return { ...emptyDraft, ...JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}') }
  } catch {
    return emptyDraft
  }
}

// The basket. Anyone can look; signing in is only needed to place the order,
// and what they typed is kept while they sign in.
export default function Checkout() {
  const basket = useBasket()
  const { session } = useSession()
  const [settings, setSettings] = useState<ShopSettings | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [draft, setDraft] = useState<Draft>(readDraft)
  const [message, setMessage] = useState('')
  const [placing, setPlacing] = useState(false)
  const [saved, setSaved] = useState<SavedAddress[]>([])
  const [keepAddress, setKeepAddress] = useState(true)
  const shopId = basket?.shopId
  const userId = session?.user.id

  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
    } catch {
      // storage unavailable
    }
  }, [draft])

  useEffect(() => {
    if (!shopId) return
    const db = supabase!
    db.from('shop_settings').select('*').eq('shop_id', shopId).maybeSingle().then(({ data }) => {
      setSettings(data)
      if (data && !data.offers_collection) update({ fulfilment: 'delivery' })
      if (data && !data.offers_delivery) update({ fulfilment: 'collection' })
    })
    db.from('shop_delivery_zones').select('name, postcode_districts, fee_pence, min_order_pence').eq('shop_id', shopId).then(({ data }) => setZones(data ?? []))
  }, [shopId])

  // Fill in the name and phone from their profile the first time.
  useEffect(() => {
    if (!userId) return
    loadAddresses().then((list) => {
      setSaved(list)
      if (list.length) setDraft((d) => (d.address ? d : { ...d, address: list[0].address, postcode: list[0].postcode }))
    })
    supabase!.from('profiles').select('display_name, phone').eq('id', userId).maybeSingle().then(({ data }) => {
      if (data) setDraft((d) => ({ ...d, name: d.name || data.display_name || '', phone: d.phone || data.phone || '' }))
    })
  }, [userId])

  if (!basket || basket.lines.length === 0) {
    return (
      <div className="stack">
        <h1>Basket</h1>
        <div className="card empty">
          <span className="big">🧺</span>
          <h2 style={{ color: 'var(--text)' }}>Your basket is empty</h2>
          <p>Find something homemade from a cook near you.</p>
          <a className="button" href="/explore" onClick={link('/explore')}>Explore food</a>
        </div>
      </div>
    )
  }

  const { fulfilment, name, phone, address, postcode, when, note } = draft
  const subtotal = basketSubtotal(basket)
  const district = postcode.trim().toUpperCase().split(/\s+/)[0]
  const zone = fulfilment === 'delivery' && district
    ? zones.filter((z) => z.postcode_districts.includes(district)).sort((a, b) => a.fee_pence - b.fee_pence)[0]
    : undefined
  const fee = zone?.fee_pence ?? 0
  const minOrder = Math.max(settings?.min_order_pence ?? 0, zone?.min_order_pence ?? 0)
  const shop = { id: basket.shopId, slug: basket.shopSlug, name: basket.shopName }
  const sameAddress = (a: SavedAddress) => a.address.trim() === address.trim() && a.postcode.replace(/\s/g, '').toUpperCase() === postcode.replace(/\s/g, '').toUpperCase()
  const isNewAddress = address.trim().length > 2 && !saved.some(sameAddress)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    if (!session) return askToSignIn('/basket')
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
    if (fulfilment === 'delivery' && keepAddress && isNewAddress && saved.length < 5) {
      await saveAddress({ label: null, address: address.trim(), postcode: postcode.trim().toUpperCase() })
    }
    writeBasket(null)
    setDraft({ ...draft, note: '', when: '' })
    navigate(`/orders/${data}`)
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <div className="section-head">
        <h1>Basket</h1>
        <span className="muted small">{basketCount(basket)} {basketCount(basket) === 1 ? 'item' : 'items'}</span>
      </div>

      <div className="card">
        <a className="small" href={`/s/${basket.shopSlug}`} onClick={link(`/s/${basket.shopSlug}`)}>
          From <strong>{basket.shopName}</strong>
        </a>
        {basket.lines.map((l) => (
          <div key={l.productId} className="basket-line">
            <span className="ph"><FoodPhoto path={l.photo ?? null} alt="" /></span>
            <span style={{ flex: 1, minWidth: 0 }} className="stack-tight">
              <strong>{l.name}</strong>
              <span className="muted small">{pounds(l.pricePence)} each</span>
              <span className="stepper">
                <button type="button" aria-label="One less" onClick={() => setQty(shop, l, l.qty - 1)}>−</button>
                <span>{l.qty}</span>
                <button type="button" className="add" aria-label="One more" onClick={() => setQty(shop, l, l.qty + 1)}>+</button>
              </span>
            </span>
            <span className="stack-tight" style={{ alignItems: 'flex-end' }}>
              <strong>{pounds(l.qty * l.pricePence)}</strong>
              <button type="button" className="icon-btn" aria-label={`Remove ${l.name}`} onClick={() => setQty(shop, l, 0)}><Icon name="trash" size={18} /></button>
            </span>
          </div>
        ))}
        <a className="small" href={`/s/${basket.shopSlug}`} onClick={link(`/s/${basket.shopSlug}`)}>+ Add more from {basket.shopName}</a>
      </div>

      <div className="stack" style={{ gap: 10 }}>
        <h2>How would you like it?</h2>
        <div className="choice">
          {settings?.offers_delivery && (
            <label className={fulfilment === 'delivery' ? 'on' : ''}>
              <input type="radio" name="fulfilment" checked={fulfilment === 'delivery'} onChange={() => update({ fulfilment: 'delivery' })} />
              <Icon name="truck" size={24} />
              <span>Delivery<small>The cook brings it to you</small></span>
            </label>
          )}
          {settings?.offers_collection !== false && (
            <label className={fulfilment === 'collection' ? 'on' : ''}>
              <input type="radio" name="fulfilment" checked={fulfilment === 'collection'} onChange={() => update({ fulfilment: 'collection' })} />
              <Icon name="bag" size={24} />
              <span>Collection<small>Address shared once accepted</small></span>
            </label>
          )}
        </div>
      </div>

      <div className="card">
        {fulfilment === 'delivery' && (
          <>
            {saved.length > 0 && (
              <div className="chips">
                {saved.map((a) => (
                  <button key={a.id} type="button" className={`chip ${sameAddress(a) ? 'on' : ''}`} onClick={() => update({ address: a.address, postcode: a.postcode })}>
                    {a.label || a.postcode}
                  </button>
                ))}
              </div>
            )}
            <label>
              Delivery address
              <textarea required rows={2} maxLength={300} value={address} onChange={(e) => update({ address: e.target.value })} autoComplete="street-address" />
            </label>
            <label>
              Postcode
              <input required maxLength={10} value={postcode} onChange={(e) => update({ postcode: e.target.value })} autoComplete="postal-code" />
            </label>
            {district && !zone && <p className="error">This cook doesn't deliver to {district}.</p>}
            {session && isNewAddress && saved.length < 5 && (
              <label className="check"><input type="checkbox" checked={keepAddress} onChange={(e) => setKeepAddress(e.target.checked)} /> Save this address for next time</label>
            )}
          </>
        )}
        <label>
          When would you like it? (optional)
          <input type="datetime-local" value={when} onChange={(e) => update({ when: e.target.value })} />
        </label>
        <label>
          Your name
          <input required maxLength={80} value={name} onChange={(e) => update({ name: e.target.value })} autoComplete="name" />
        </label>
        <label>
          Phone (so the cook can reach you)
          <input type="tel" maxLength={30} value={phone} onChange={(e) => update({ phone: e.target.value })} autoComplete="tel" />
        </label>
        <label>
          Note for the cook (optional)
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => update({ note: e.target.value })} placeholder="Allergies, timing, anything else" />
        </label>
      </div>

      <div className="card">
        <h2>Order summary</h2>
        <div className="item"><span>Food</span><span>{pounds(subtotal)}</span></div>
        {fulfilment === 'delivery' && <div className="item"><span>Delivery</span><span>{zone ? (fee ? pounds(fee) : 'Free') : '–'}</span></div>}
        <div className="item total"><strong>Total</strong><strong>{pounds(subtotal + fee)}</strong></div>
        {minOrder > subtotal && <p className="error small">This cook's minimum order is {pounds(minOrder)}.</p>}
        <p className="muted tiny">You pay before the cook starts. If they can't take your order, you get your money back.</p>
      </div>

      <button type="submit" className="dark block action-bar" disabled={placing}>
        {placing ? 'Placing order…' : session ? `Place order · ${pounds(subtotal + fee)}` : 'Sign in to place your order'}
      </button>
      {message && <p className="error">{message}</p>}
    </form>
  )
}
