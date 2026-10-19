import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { locatePostcode } from '../lib/geo'
import { addDays, shortDate } from '../lib/hours'
import { link, navigate } from '../lib/router'
import { deletePhoto, photoUrl, uploadPhoto } from '../lib/images'
import { ImageCropper } from '../lib/ImageCropper'
import { Icon, type IconName } from '../lib/icons'
import { pounds, type SellerAccount, type Shop, type ShopPrivate, type ShopSettings } from '../lib/types'

function toSlug(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// A collapsible section, like the dashboard cards: icon, title and a one-line
// summary; tap to open.
function Section({ icon, title, summary, badge, open, dark, children }: { icon: IconName; title: string; summary: string; badge?: string; open?: boolean; dark?: boolean; children: React.ReactNode }) {
  return (
    <details className={`card set-sec${dark ? ' dark' : ''}`} open={open || undefined}>
      <summary>
        <span className="sum-row">
          <span className="set-icon"><Icon name={icon} size={20} /></span>
          <span className="sum-text">
            <strong>{title}</strong>
            <span className="muted small">{summary}</span>
          </span>
        </span>
        {badge && <span className="set-badge">{badge}</span>}
      </summary>
      <div className="details-body">{children}</div>
    </details>
  )
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
      const { data: account } = await db.from('seller_accounts').select('*').eq('user_id', await myUserId()).maybeSingle()
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
  const [linkLockedUntil, setLinkLockedUntil] = useState<string | null>(null)
  useEffect(() => {
    if (shop) supabase!.rpc('shop_link_info', { p_shop: shop.id }).then(({ data }) => setLinkLockedUntil(data?.locked_until ?? null))
  }, [shop])
  const [story, setStory] = useState(shop?.story ?? '')
  const [area, setArea] = useState(shop?.area_label ?? '')
  const [cuisines, setCuisines] = useState((shop?.cuisines ?? []).join(', '))
  const [collection, setCollection] = useState(settings?.offers_collection ?? true)
  const [delivery, setDelivery] = useState(settings?.offers_delivery ?? false)
  const [catering, setCatering] = useState(settings?.takes_catering ?? false)
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
    try {
      await saveShop()
    } catch (err) {
      fail(`Couldn’t save: ${(err as Error).message || 'check your connection and try again'}.`)
    }
  }

  async function saveShop() {
    if (name.trim().length < 2) return fail('Add your shop name (at least 2 letters).')
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) return fail('Your shop link needs 3 to 40 lowercase letters, numbers or dashes.')
    if (!collection && !delivery) return fail('Choose collection, delivery or both.')
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
      if (error) return fail(error.code === '23505' ? 'That link is taken. Try another one.' : error.message)
    } else {
      // The id is chosen here: reading the new row back in the same request
      // would fail, because the ownership check can't see it yet.
      shopId = crypto.randomUUID()
      const { error } = await db.from('shops').insert({ ...shopValues, id: shopId, seller_account_id: account.id })
      if (error) return fail(error.code === '23505' ? 'That link is taken. Try another one.' : error.message)
    }
    // The home's location (never shown) lets customers find nearby cooks.
    const cleanPostcode = postcode.trim().toUpperCase()
    let point = priv?.lat != null && priv.postcode === cleanPostcode ? { lat: priv.lat, lng: priv.lng! } : null
    if (!point && cleanPostcode) point = await locatePostcode(cleanPostcode)
    const [s, p] = await Promise.all([
      db.from('shop_settings').upsert({
        shop_id: shopId,
        offers_collection: collection,
        offers_delivery: delivery,
        takes_catering: catering,
        min_order_pence: Math.round((parseFloat(minOrder) || 0) * 100),
      }),
      db.from('shop_private').upsert({
        shop_id: shopId,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
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
    else setMessage('Saved ✓ Your changes are live.')
  }

  // Each section has its own Save button; they all save the whole form, and
  // the message shows under the one that was tapped.
  const [from, setFrom] = useState('')
  function saveButton(section: string) {
    return (
      <>
        <button type="submit" disabled={saving} onClick={() => setFrom(section)}>{saving && from === section ? 'Saving…' : 'Save'}</button>
        {message && from === section && <p className={message.startsWith('Saved') ? 'status small' : 'error'} role="status">{message}</p>}
      </>
    )
  }

  function fail(text: string) {
    setSaving(false)
    setMessage(text)
  }

  async function setLive(live: boolean) {
    setFrom('open')
    const { error } = await supabase!.from('shops').update({ status: live ? 'live' : 'paused' }).eq('id', shop!.id)
    if (error) setMessage(error.message)
    else window.location.reload()
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <h1>{shop ? 'Your shop' : 'Set up your shop'}</h1>

      {shop && (
        <Section icon="store" title="Open for orders" dark
          summary={!canGoLive ? 'Not live yet' : shop.status === 'live' ? (accepting ? 'Live and taking orders' : 'Live, not taking orders') : 'Hidden from customers'}
          badge={canGoLive && shop.status === 'live' ? 'Live' : undefined}>
          {canGoLive ? (
            <>
              <label className="check">
                <input type="checkbox" checked={accepting} onChange={(e) => setAccepting(e.target.checked)} />
                Taking orders right now
              </label>
              <button type="button" className="secondary" onClick={() => setLive(shop.status !== 'live')}>
                {shop.status === 'live' ? 'Hide my shop' : 'Make my shop live'}
              </button>
              {saveButton('open')}
            </>
          ) : (
            <p className="muted small">
              Your shop can go live once your application is approved, your food insurance is uploaded and payments are set up.
              Until then only you can see it.
            </p>
          )}
        </Section>
      )}

      <Section icon="edit" title="Shop details" open={!shop} summary={shop ? `${name || 'No name yet'} · ${window.location.host}/s/${slug}` : 'Name, link and story'}>
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
            <span>{window.location.host}/s/</span>
            <input
              required
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              title="3 to 40 lowercase letters, numbers or dashes"
              value={slug}
              disabled={Boolean(linkLockedUntil)}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(toSlug(e.target.value))
              }}
            />
          </div>
          <span className="muted tiny">
            {linkLockedUntil
              ? `You changed your link recently. You can change it again from ${new Date(linkLockedUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.`
              : shop && shop.status !== 'draft'
                ? 'You can change your link once every 30 days. Old links, QR codes and posts keep working.'
                : 'This is the link you’ll share. Pick it carefully: once your shop is open you can only change it once every 30 days.'}
          </span>
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
        {shop && saveButton('details')}
      </Section>

      {shop && <ShopPhotos shop={shop} />}
      {shop && <ShopNotice shop={shop} />}

      <Section icon="truck" title="Collection and delivery" open={!shop}
        summary={[collection && 'Collection', delivery && 'Delivery', catering && 'Catering'].filter(Boolean).join(' · ') || 'Choose how customers get their food'}>
        <label className="check">
          <input type="checkbox" checked={collection} onChange={(e) => setCollection(e.target.checked)} />
          Collection from me
        </label>
        <label className="check">
          <input type="checkbox" checked={delivery} onChange={(e) => setDelivery(e.target.checked)} />
          I deliver myself
        </label>
        {delivery && <p className="muted tiny" style={{ margin: 0 }}>If you deliver by car, your car insurance needs to cover business use (ask your insurer: it’s often a small add-on).</p>}
        <label className="check">
          <input type="checkbox" checked={catering} onChange={(e) => setCatering(e.target.checked)} />
          I take catering and party orders (customers can ask you for a quote)
        </label>
        <label>
          Minimum order (£)
          <input type="number" min="0" max="1000" step="0.5" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} />
        </label>
        {shop && saveButton('how')}
      </Section>
      {shop && delivery && <DeliveryRadius shopId={shop.id} />}
      {shop && delivery && <DeliveryZones shopId={shop.id} />}
      {shop && <OpeningHours shopId={shop.id} />}
      {shop && <DailyLimit shopId={shop.id} />}

      <Section icon="lock" title="Private details" open={!shop} summary={postcode ? `${postcode.toUpperCase()} · only you can see these` : 'Your address and phone, never shown'}>
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
        {shop && saveButton('private')}
      </Section>

      {!shop && <button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Create my shop'}</button>}
      {!shop && message && <p className="error" role="status">{message}</p>}
    </form>
  )
}

// The most orders a cook takes for one day. When a day is full, customers
// are asked to choose another day.
function DailyLimit({ shopId }: { shopId: string }) {
  const [max, setMax] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    supabase!.from('shop_settings').select('max_orders_per_day').eq('shop_id', shopId).maybeSingle().then(({ data }) => {
      setMax(data?.max_orders_per_day ? String(data.max_orders_per_day) : '')
    })
  }, [shopId])

  async function save() {
    setMessage('')
    const n = max ? Math.round(Number(max)) : null
    if (n !== null && !(n >= 1 && n <= 500)) return setMessage('Choose between 1 and 500 orders.')
    const { error } = await supabase!.from('shop_settings').update({ max_orders_per_day: n }).eq('shop_id', shopId)
    setMessage(error ? error.message : n ? `Saved: up to ${n} ${n === 1 ? 'order' : 'orders'} a day.` : 'Saved: no daily limit.')
  }

  return (
    <Section icon="orders" title="Orders per day" summary={max ? `Up to ${max} a day` : 'No limit'}>
      <p className="muted small">Only cook as much as you can manage. When a day is full, customers are asked to pick another day.</p>
      <label>
        Most orders I take in a day
        <input type="number" inputMode="numeric" min={1} max={500} value={max} onChange={(e) => setMax(e.target.value)} placeholder="No limit" />
      </label>
      <button type="button" onClick={save}>Save</button>
      {message && <p className="muted small">{message}</p>}
    </Section>
  )
}

type Zone = { id: string; name: string; postcode_districts: string[]; fee_pence: number; min_order_pence: number }

// Delivery areas, by postcode district (e.g. E3, E14), each with its own fee.
// Deliver to anyone within a number of miles of home.
function DeliveryRadius({ shopId }: { shopId: string }) {
  const [miles, setMiles] = useState('')
  const [fee, setFee] = useState('')
  const [min, setMin] = useState('')
  const [located, setLocated] = useState(true)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const db = supabase!
    db.from('shop_settings').select('delivery_radius_miles, radius_fee_pence, radius_min_order_pence').eq('shop_id', shopId).maybeSingle().then(({ data }) => {
      if (!data) return
      setMiles(data.delivery_radius_miles ? String(data.delivery_radius_miles) : '')
      setFee(data.radius_fee_pence ? (data.radius_fee_pence / 100).toFixed(2) : '')
      setMin(data.radius_min_order_pence ? (data.radius_min_order_pence / 100).toFixed(2) : '')
    })
    db.from('shop_private').select('lat').eq('shop_id', shopId).maybeSingle().then(({ data }) => setLocated(data?.lat != null))
  }, [shopId])

  async function save() {
    setMessage('')
    const radius = miles ? Number(miles) : null
    const { error } = await supabase!.from('shop_settings').update({
      delivery_radius_miles: radius,
      radius_fee_pence: Math.round((parseFloat(fee) || 0) * 100),
      radius_min_order_pence: Math.round((parseFloat(min) || 0) * 100),
    }).eq('shop_id', shopId)
    setMessage(error ? error.message : radius ? `Saved: you deliver within ${radius} miles.` : 'Saved: delivery by distance is off.')
  }

  return (
    <Section icon="map" title="Deliver by distance" summary={miles ? `Within ${miles} ${miles === '1' ? 'mile' : 'miles'}` : 'Off'}>
      <p className="muted small">The simplest option: deliver to anyone within a set distance of your home. Customers only ever see a rough distance, never your address.</p>
      {!located && <p className="status small">Add your postcode in "Collection address" above and save, so we know where you are.</p>}
      <label>
        Deliver within
        <select value={miles} onChange={(e) => setMiles(e.target.value)}>
          <option value="">Off (use postcode areas below)</option>
          {[0.5, 1, 1.5, 2, 3, 4, 5, 7, 10].map((m) => <option key={m} value={m}>{m} {m === 1 ? 'mile' : 'miles'}</option>)}
        </select>
      </label>
      {miles && (
        <div className="row">
          <label>
            Delivery fee (£)
            <input type="number" min="0" max="100" step="0.5" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="0" />
          </label>
          <label>
            Minimum order (£)
            <input type="number" min="0" max="1000" step="0.5" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
          </label>
        </div>
      )}
      <button type="button" onClick={save}>Save</button>
      {message && <p className="muted small">{message}</p>}
    </Section>
  )
}

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
    <Section icon="pin" title="Postcode areas" summary={zones.length ? zones.flatMap((z) => z.postcode_districts).join(', ') : 'None added'}>
      <p className="muted small">Use the first part of the postcode, like E3 or E14. You can use this as well as, or instead of, a distance. Customers you don't deliver to can still collect.</p>
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
    </Section>
  )
}

// Logo and cover photo, saved as soon as they are chosen.
function ShopPhotos({ shop }: { shop: Shop }) {
  const [logo, setLogo] = useState(shop.logo_path)
  const [cover, setCover] = useState(shop.cover_path)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [cropping, setCropping] = useState<{ kind: 'logo' | 'cover'; file: File } | null>(null)

  async function replace(kind: 'logo' | 'cover', blob: Blob) {
    setCropping(null)
    setBusy(kind)
    setMessage('')
    try {
      const path = await uploadPhoto(shop.id, blob)
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
    <Section icon="star" title="Shop photos" summary={logo && cover ? 'Logo and cover photo added' : 'Add a logo and a cover photo'}>
      <div className="shop-photos">
        <div>
          <p className="small">Logo or your photo</p>
          {logo ? <img className="logo" src={photoUrl(logo)!} alt="" /> : <div className="logo placeholder" />}
          <label className="button secondary upload small-btn">
            {busy === 'logo' ? 'Uploading…' : logo ? 'Change' : 'Add'}
            <input type="file" accept="image/*" disabled={Boolean(busy)} onChange={(e) => { const f = e.target.files?.[0]; if (f) setCropping({ kind: 'logo', file: f }); e.target.value = '' }} />
          </label>
        </div>
        <div className="grow">
          <p className="small">Cover photo (your best dish)</p>
          {cover ? <img className="cover" src={photoUrl(cover)!} alt="" /> : <div className="cover placeholder" />}
          <label className="button secondary upload small-btn">
            {busy === 'cover' ? 'Uploading…' : cover ? 'Change' : 'Add'}
            <input type="file" accept="image/*" disabled={Boolean(busy)} onChange={(e) => { const f = e.target.files?.[0]; if (f) setCropping({ kind: 'cover', file: f }); e.target.value = '' }} />
          </label>
        </div>
      </div>
      <p className="muted small">After choosing a photo you can drag and zoom to pick exactly what shows.</p>
      {message && <p className="error">{message}</p>}
      {cropping && (
        <ImageCropper
          file={cropping.file}
          {...(cropping.kind === 'logo'
            ? { aspect: 1, round: true, width: 400, title: 'Logo or your photo', hint: 'Fit your face or logo inside the circle.' }
            : { aspect: 2, width: 1600, jpeg: true, title: 'Cover photo', hint: 'This is the banner at the top of your shop page.' })}
          onCancel={() => setCropping(null)}
          onDone={(blob) => replace(cropping.kind, blob)}
        />
      )}
    </Section>
  )
}

// A short message at the top of the shop page, optionally until a date.
function ShopNotice({ shop }: { shop: Shop }) {
  const [text, setText] = useState(shop.notice ?? '')
  // A date that has already passed is cleared, so it doesn't block saving.
  const [until, setUntil] = useState(shop.notice_until && shop.notice_until >= new Date().toISOString().slice(0, 10) ? shop.notice_until : '')
  const [message, setMessage] = useState('')

  async function save(clear = false) {
    setMessage('')
    const notice = clear ? null : text.trim() || null
    const { error } = await supabase!.from('shops')
      .update({ notice, notice_until: notice ? until || null : null }).eq('id', shop.id)
    if (error) return setMessage(error.message)
    if (clear) { setText(''); setUntil('') }
    setMessage(notice ? 'Announcement saved. It shows at the top of your shop.' : 'Announcement removed')
  }

  return (
    <Section icon="bell" title="Announcement" summary={shop.notice && text ? text : 'None showing'} badge={shop.notice && text ? 'On' : undefined}>
      <p className="muted small">A short message at the top of your shop page, like a special or a change to your hours.</p>
      <textarea rows={2} maxLength={160} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Jerk chicken this Saturday only. Order by Friday!" aria-label="Announcement" />
      <label>
        Show until (optional)
        <input type="date" value={until} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setUntil(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" className="secondary" onClick={() => save()} disabled={!text.trim()}>Save announcement</button>
        {shop.notice !== undefined && text && <button type="button" className="secondary" onClick={() => save(true)}>Remove</button>}
      </div>
      {message && <p className="muted small">{message}</p>}
    </Section>
  )
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
type Day = { open: boolean; opens: string; closes: string }
type Closure = { id: string; closed_on: string; reason: string | null }

// Days off in a row with the same reason show as one holiday.
function closureRuns(list: Closure[]) {
  const runs: Closure[][] = []
  for (const c of list) {
    const run = runs[runs.length - 1]
    const prev = run?.[run.length - 1]
    if (prev && addDays(prev.closed_on, 1) === c.closed_on && prev.reason === c.reason) run.push(c)
    else runs.push([c])
  }
  return runs
}

// Weekly opening hours (one time range per day) and days off.
function OpeningHours({ shopId }: { shopId: string }) {
  const [days, setDays] = useState<Day[] | null>(null)
  const [closures, setClosures] = useState<Closure[]>([])
  const [offDate, setOffDate] = useState('')
  const [offUntil, setOffUntil] = useState('')
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
  const openDays = days.filter((d) => d.open).length
  const openSummary = `${openDays ? `Open ${openDays} ${openDays === 1 ? 'day' : 'days'} a week` : 'No hours set'}${closures.length ? ` · ${closures.length} ${closures.length === 1 ? 'day' : 'days'} off coming up` : ''}`

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
    const last = offUntil && offUntil > offDate ? offUntil : offDate
    const dates: string[] = []
    for (let d = offDate; d <= last && dates.length < 60; d = addDays(d, 1)) dates.push(d)
    const reason = offReason.trim() || null
    const { error } = await supabase!.from('shop_closures')
      .upsert(dates.map((closed_on) => ({ shop_id: shopId, closed_on, reason })), { onConflict: 'shop_id,closed_on', ignoreDuplicates: true })
    if (error) return setMessage(error.message)
    setMessage(dates.length > 1 ? `Away for ${dates.length} days. Customers can't order for those days.` : 'Day off added')
    setOffDate('')
    setOffUntil('')
    setOffReason('')
    load()
  }

  async function removeClosures(ids: string[]) {
    await supabase!.from('shop_closures').delete().in('id', ids)
    load()
  }

  return (
    <Section icon="clock" title="Opening hours and days off" summary={openSummary}>
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
      <button type="button" onClick={saveHours}>Save hours</button>

      <h3 className="set-sub">Days off and holidays</h3>
      <p className="muted small">Customers can’t order for these days, and your shop shows when you’re back.</p>
      {closureRuns(closures).map((run) => (
        <div key={run[0].id} className="check-row">
          <span className="small">{shortDate(run[0].closed_on)}{run.length > 1 && ` to ${shortDate(run[run.length - 1].closed_on)}`}{run[0].reason && ` · ${run[0].reason}`}</span>
          <button type="button" className="secondary small-btn" onClick={() => removeClosures(run.map((c) => c.id))}>Remove</button>
        </div>
      ))}
      <div className="row">
        <label className="grow">From<input type="date" value={offDate} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setOffDate(e.target.value)} /></label>
        <label className="grow">Until (optional)<input type="date" value={offUntil} min={offDate || new Date().toISOString().slice(0, 10)} onChange={(e) => setOffUntil(e.target.value)} /></label>
      </div>
      <input value={offReason} maxLength={200} onChange={(e) => setOffReason(e.target.value)} placeholder="Reason, shown to customers (optional), e.g. On holiday" aria-label="Reason" />
      <button type="button" className="secondary" onClick={addClosure} disabled={!offDate}>{offUntil && offUntil > offDate ? 'Add holiday' : 'Add day off'}</button>
      {message && <p className="muted">{message}</p>}
    </Section>
  )
}
