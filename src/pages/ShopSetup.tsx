import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import type { SellerAccount, Shop, ShopPrivate, ShopSettings } from '../lib/types'

function toSlug(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

type Loaded = {
  account: SellerAccount | null
  shop: Shop | null
  settings: ShopSettings | null
  priv: ShopPrivate | null
}

export default function ShopSetup() {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('*').maybeSingle()
      let shop: Shop | null = null
      let settings: ShopSettings | null = null
      let priv: ShopPrivate | null = null
      if (account) {
        const { data: shops } = await db.from('shops').select('*').eq('seller_account_id', account.id).limit(1)
        shop = shops?.[0] ?? null
        if (shop) {
          const [s, p] = await Promise.all([
            db.from('shop_settings').select('*').eq('shop_id', shop.id).maybeSingle(),
            db.from('shop_private').select('*').eq('shop_id', shop.id).maybeSingle(),
          ])
          settings = s.data
          priv = p.data
        }
      }
      setLoaded({ account, shop, settings, priv })
    })()
  }, [])

  if (!loaded) return <p className="muted">Loading…</p>
  if (!loaded.account) {
    return (
      <div className="card">
        <p>Fill in step 1 of your seller account first.</p>
        <a className="button" href="/sell" onClick={link('/sell')}>Go to seller account</a>
      </div>
    )
  }
  return <ShopForm {...loaded} account={loaded.account} />
}

function ShopForm({ account, shop, settings, priv }: Loaded & { account: SellerAccount }) {
  const [name, setName] = useState(shop?.name ?? '')
  const [slug, setSlug] = useState(shop?.slug ?? '')
  const [slugTouched, setSlugTouched] = useState(Boolean(shop))
  const [story, setStory] = useState(shop?.story ?? '')
  const [area, setArea] = useState(shop?.area_label ?? '')
  const [cuisines, setCuisines] = useState((shop?.cuisines ?? []).join(', '))
  const [collection, setCollection] = useState(settings?.offers_collection ?? true)
  const [delivery, setDelivery] = useState(settings?.offers_delivery ?? false)
  const [minOrder, setMinOrder] = useState(settings ? String(settings.min_order_pence / 100) : '0')
  const [address1, setAddress1] = useState(priv?.address_line1 ?? '')
  const [address2, setAddress2] = useState(priv?.address_line2 ?? '')
  const [city, setCity] = useState(priv?.city ?? 'London')
  const [postcode, setPostcode] = useState(priv?.postcode ?? '')
  const [instructions, setInstructions] = useState(priv?.collection_instructions ?? '')
  const [phone, setPhone] = useState(priv?.contact_phone ?? '')
  const [accepting, setAccepting] = useState(shop?.accepting_orders ?? false)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const canGoLive = account.status === 'approved' && account.charges_enabled

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!collection && !delivery) return setMessage('Choose collection, delivery or both.')
    setSaving(true)
    setMessage('')
    const db = supabase!
    const shopValues = {
      name: name.trim(),
      slug,
      story: story.trim() || null,
      area_label: area.trim() || null,
      cuisines: cuisines.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 10),
    }
    let shopId = shop?.id
    if (shopId) {
      const { error } = await db.from('shops').update({ ...shopValues, accepting_orders: accepting }).eq('id', shopId)
      if (error) return fail(error.message)
    } else {
      // The id is chosen here: reading the new row back in the same request
      // would fail, because the ownership check can't see it yet.
      shopId = crypto.randomUUID()
      const { error } = await db.from('shops').insert({ ...shopValues, id: shopId, seller_account_id: account.id })
      if (error) return fail(error.code === '23505' ? 'That link is taken. Try another one.' : error.message)
    }
    const [s, p] = await Promise.all([
      db.from('shop_settings').upsert({
        shop_id: shopId,
        offers_collection: collection,
        offers_delivery: delivery,
        min_order_pence: Math.round((parseFloat(minOrder) || 0) * 100),
      }),
      db.from('shop_private').upsert({
        shop_id: shopId,
        address_line1: address1.trim() || null,
        address_line2: address2.trim() || null,
        city: city.trim() || null,
        postcode: postcode.trim().toUpperCase() || null,
        collection_instructions: instructions.trim() || null,
        contact_phone: phone.trim() || null,
      }),
    ])
    if (s.error || p.error) return fail((s.error ?? p.error)!.message)
    setSaving(false)
    if (!shop) navigate('/sell/products')
    else setMessage('Saved')
  }

  function fail(text: string) {
    setSaving(false)
    setMessage(text)
  }

  async function setLive(live: boolean) {
    const { error } = await supabase!.from('shops').update({ status: live ? 'live' : 'paused' }).eq('id', shop!.id)
    if (error) setMessage(error.message)
    else window.location.reload()
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <h1>{shop ? 'Your shop' : 'Set up your shop'}</h1>

      <div className="card">
        <h2>Shop details</h2>
        <label>
          Shop name
          <input
            required
            minLength={2}
            maxLength={80}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugTouched) setSlug(toSlug(e.target.value))
            }}
          />
        </label>
        <label>
          Your shop link
          <div className="prefix">
            <span>food.beastcase.net/s/</span>
            <input
              required
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              title="3 to 40 lowercase letters, numbers or dashes"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(toSlug(e.target.value))
              }}
            />
          </div>
        </label>
        <label>
          Your story (optional)
          <textarea maxLength={2000} rows={4} value={story} onChange={(e) => setStory(e.target.value)} placeholder="Who you are and what you cook" />
        </label>
        <label>
          Area shown to customers
          <input maxLength={60} value={area} onChange={(e) => setArea(e.target.value)} placeholder="e.g. Bow, E3" />
        </label>
        <p className="muted small">Only the area is public. Never put your street or house number here.</p>
        <label>
          Cuisines (separate with commas)
          <input value={cuisines} onChange={(e) => setCuisines(e.target.value)} placeholder="e.g. Nigerian, Caribbean, Vegan" />
        </label>
      </div>

      <div className="card">
        <h2>How customers get their food</h2>
        <label className="check">
          <input type="checkbox" checked={collection} onChange={(e) => setCollection(e.target.checked)} />
          Collection from me
        </label>
        <label className="check">
          <input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} />
          I deliver myself
        </label>
        <label>
          Minimum order (£)
          <input type="number" min="0" max="1000" step="0.5" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
        </label>
      </div>

      <div className="card">
        <h2>Private details</h2>
        <p className="muted small">
          Never shown on your shop. A customer only sees your collection address after you accept
          their paid order.
        </p>
        <label>
          Address line 1
          <input maxLength={200} value={address1} onChange={(e) => setAddress1(e.target.value)} autoComplete="address-line1" />
        </label>
        <label>
          Address line 2
          <input maxLength={200} value={address2} onChange={(e) => setAddress2(e.target.value)} autoComplete="address-line2" />
        </label>
        <div className="row">
          <label>
            Town
            <input maxLength={100} value={city} onChange={(e) => setCity(e.target.value)} autoComplete="address-level2" />
          </label>
          <label>
            Postcode
            <input maxLength={10} value={postcode} onChange={(e) => setPostcode(e.target.value)} autoComplete="postal-code" />
          </label>
        </div>
        <label>
          Collection instructions
          <textarea maxLength={500} rows={2} value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder="e.g. Ring the top bell" />
        </label>
        <label>
          Phone for order questions
          <input type="tel" maxLength={30} value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" />
        </label>
      </div>

      {shop && (
        <div className="card">
          <h2>Open for orders</h2>
          {canGoLive ? (
            <>
              <p className="muted">Your shop is {shop.status === 'live' ? 'live' : 'not live'}.</p>
              <button type="button" onClick={() => setLive(shop.status !== 'live')}>
                {shop.status === 'live' ? 'Hide my shop' : 'Make my shop live'}
              </button>
              <label className="check">
                <input type="checkbox" checked={accepting} onChange={(e) => setAccepting(e.target.checked)} />
                Taking orders right now
              </label>
            </>
          ) : (
            <p className="muted">
              Your shop can go live once your application is approved and payments are set up.
              Until then only you can see it.
            </p>
          )}
        </div>
      )}

      <button type="submit" disabled={saving}>{saving ? 'Saving…' : shop ? 'Save' : 'Create my shop'}</button>
      {message && <p className="muted">{message}</p>}
    </form>
  )
}
