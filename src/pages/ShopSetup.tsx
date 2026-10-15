import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { deletePhoto, photoUrl, uploadPhoto } from '../lib/images'
import { pounds, type SellerAccount, type Shop, type ShopPrivate, type ShopSettings } from '../lib/types'

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

      {shop && <ShopPhotos shop={shop} />}
      {shop && <OpeningHours shopId={shop.id} />}
      {shop && delivery && <DeliveryZones shopId={shop.id} />}

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

type Zone = { id: string; name: string; postcode_districts: string[]; fee_pence: number; min_order_pence: number }

// Delivery areas, by postcode district (e.g. E3, E14), each with its own fee.
function DeliveryZones({ shopId }: { shopId: string }) {
  const [zones, setZones] = useState<Zone[]>([])
  const [name, setName] = useState('')
  const [districts, setDistricts] = useState('')
  const [fee, setFee] = useState('')
  const [min, setMin] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase!.from('shop_delivery_zones').select('*').eq('shop_id', shopId).order('fee_pence')
    setZones(data ?? [])
  }, [shopId])

  useEffect(() => {
    load()
  }, [load])

  async function add() {
    const list = districts.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 50)
    if (!list.length) return setMessage('Add at least one postcode area, like E3.')
    const { error } = await supabase!.from('shop_delivery_zones').insert({
      shop_id: shopId,
      name: name.trim() || list.join(', ').slice(0, 60),
      postcode_districts: list,
      fee_pence: Math.round((parseFloat(fee) || 0) * 100),
      min_order_pence: Math.round((parseFloat(min) || 0) * 100),
    })
    if (error) return setMessage(error.message)
    setName('')
    setDistricts('')
    setFee('')
    setMin('')
    setMessage('')
    load()
  }

  async function remove(id: string) {
    await supabase!.from('shop_delivery_zones').delete().eq('id', id)
    load()
  }

  return (
    <div className="card">
      <h2>Where you deliver</h2>
      <p className="muted small">Use the first part of the postcode, like E3 or E14. Customers outside these areas can only collect.</p>
      {zones.map((z) => (
        <div key={z.id} className="check-row">
          <div className="small">
            <strong>{z.postcode_districts.join(', ')}</strong> · fee {pounds(z.fee_pence)}
            {z.min_order_pence > 0 && ` · min ${pounds(z.min_order_pence)}`}
          </div>
          <button type="button" className="secondary small-btn" onClick={() => remove(z.id)}>Remove</button>
        </div>
      ))}
      <label>
        Postcode areas
        <input value={districts} onChange={(e) => setDistricts(e.target.value)} placeholder="e.g. E3, E2, E14" />
      </label>
      <div className="row">
        <label>
          Delivery fee (£)
          <input type="number" min="0" max="100" step="0.5" value={fee} onChange={(e) => setFee(e.target.value)} />
        </label>
        <label>
          Minimum order (£)
          <input type="number" min="0" max="1000" step="0.5" value={min} onChange={(e) => setMin(e.target.value)} />
        </label>
      </div>
      <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Name for this area (optional)" />
      <button type="button" className="secondary" onClick={add}>Add delivery area</button>
      {message && <p className="error">{message}</p>}
    </div>
  )
}

// Logo and cover photo, saved as soon as they are chosen.
function ShopPhotos({ shop }: { shop: Shop }) {
  const [logo, setLogo] = useState(shop.logo_path)
  const [cover, setCover] = useState(shop.cover_path)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')

  async function replace(kind: 'logo' | 'cover', file: File | undefined) {
    if (!file) return
    setBusy(kind)
    setMessage('')
    try {
      const path = await uploadPhoto(shop.id, file, kind === 'logo' ? 400 : 1600, kind === 'cover')
      const column = kind === 'logo' ? 'logo_path' : 'cover_path'
      const { error } = await supabase!.from('shops').update({ [column]: path }).eq('id', shop.id)
      if (error) {
        await deletePhoto(path)
        throw new Error(error.message)
      }
      const old = kind === 'logo' ? logo : cover
      if (old) await deletePhoto(old)
      if (kind === 'logo') setLogo(path)
      else setCover(path)
    } catch (e) {
      setMessage((e as Error).message)
    }
    setBusy('')
  }

  return (
    <div className="card">
      <h2>Shop photos</h2>
      <div className="shop-photos">
        <div>
          <p className="small">Logo or your photo</p>
          {logo ? <img className="logo" src={photoUrl(logo)!} alt="" /> : <div className="logo placeholder" />}
          <label className="button secondary upload small-btn">
            {busy === 'logo' ? 'Uploading…' : logo ? 'Change' : 'Add'}
            <input type="file" accept="image/*" disabled={Boolean(busy)} onChange={(e) => { replace('logo', e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
        <div className="grow">
          <p className="small">Cover photo (your best dish)</p>
          {cover ? <img className="cover" src={photoUrl(cover)!} alt="" /> : <div className="cover placeholder" />}
          <label className="button secondary upload small-btn">
            {busy === 'cover' ? 'Uploading…' : cover ? 'Change' : 'Add'}
            <input type="file" accept="image/*" disabled={Boolean(busy)} onChange={(e) => { replace('cover', e.target.files?.[0]); e.target.value = '' }} />
          </label>
        </div>
      </div>
      {message && <p className="error">{message}</p>}
    </div>
  )
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
type Day = { open: boolean; opens: string; closes: string }
type Closure = { id: string; closed_on: string; reason: string | null }

// Weekly opening hours (one time range per day) and days off.
function OpeningHours({ shopId }: { shopId: string }) {
  const [days, setDays] = useState<Day[] | null>(null)
  const [closures, setClosures] = useState<Closure[]>([])
  const [offDate, setOffDate] = useState('')
  const [offReason, setOffReason] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const db = supabase!
    const [h, c] = await Promise.all([
      db.from('shop_hours').select('weekday, opens, closes').eq('shop_id', shopId),
      db.from('shop_closures').select('id, closed_on, reason').eq('shop_id', shopId)
        .gte('closed_on', new Date().toISOString().slice(0, 10)).order('closed_on'),
    ])
    setDays(DAYS.map((_, i) => {
      const row = h.data?.find((r) => r.weekday === i)
      return row ? { open: true, opens: row.opens.slice(0, 5), closes: row.closes.slice(0, 5) } : { open: false, opens: '10:00', closes: '18:00' }
    }))
    setClosures(c.data ?? [])
  }, [shopId])

  useEffect(() => {
    load()
  }, [load])

  if (!days) return null

  function set(i: number, change: Partial<Day>) {
    setDays(days!.map((d, j) => (j === i ? { ...d, ...change } : d)))
  }

  async function saveHours() {
    setMessage('')
    const bad = days!.findIndex((d) => d.open && d.closes <= d.opens)
    if (bad >= 0) return setMessage(`${DAYS[bad]}: closing time must be after opening time.`)
    const db = supabase!
    const { error: delError } = await db.from('shop_hours').delete().eq('shop_id', shopId)
    if (delError) return setMessage(delError.message)
    const rows = days!.flatMap((d, i) => (d.open ? [{ shop_id: shopId, weekday: i, opens: d.opens, closes: d.closes }] : []))
    if (rows.length) {
      const { error } = await db.from('shop_hours').insert(rows)
      if (error) return setMessage(error.message)
    }
    setMessage('Hours saved')
  }

  async function addClosure() {
    if (!offDate) return
    const { error } = await supabase!.from('shop_closures').insert({ shop_id: shopId, closed_on: offDate, reason: offReason.trim() || null })
    if (error) return setMessage(error.code === '23505' ? 'That day is already marked off.' : error.message)
    setOffDate('')
    setOffReason('')
    load()
  }

  async function removeClosure(id: string) {
    await supabase!.from('shop_closures').delete().eq('id', id)
    load()
  }

  return (
    <div className="card">
      <h2>Opening hours</h2>
      <p className="muted small">When customers can collect or get deliveries.</p>
      {days.map((d, i) => (
        <div key={i} className="hours-row">
          <label className="check">
            <input type="checkbox" checked={d.open} onChange={(e) => set(i, { open: e.target.checked })} />
            {DAYS[i]}
          </label>
          {d.open ? (
            <span className="times">
              <input type="time" value={d.opens} onChange={(e) => set(i, { opens: e.target.value })} aria-label={`${DAYS[i]} opens`} />
              <span>to</span>
              <input type="time" value={d.closes} onChange={(e) => set(i, { closes: e.target.value })} aria-label={`${DAYS[i]} closes`} />
            </span>
          ) : (
            <span className="muted small">Closed</span>
          )}
        </div>
      ))}
      <button type="button" className="secondary" onClick={saveHours}>Save hours</button>

      <h2>Days off</h2>
      {closures.map((c) => (
        <div key={c.id} className="check-row">
          <span className="small">{new Date(c.closed_on + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}{c.reason && ` · ${c.reason}`}</span>
          <button type="button" className="secondary small-btn" onClick={() => removeClosure(c.id)}>Remove</button>
        </div>
      ))}
      <div className="row">
        <input type="date" value={offDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setOffDate(e.target.value)} aria-label="Day off" />
        <input value={offReason} maxLength={200} onChange={(e) => setOffReason(e.target.value)} placeholder="Reason (optional)" />
      </div>
      <button type="button" className="secondary" onClick={addClosure} disabled={!offDate}>Add day off</button>
      {message && <p className="muted">{message}</p>}
    </div>
  )
}
