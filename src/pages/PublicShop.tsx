import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { photoUrl } from '../lib/images'
import { ReviewItem, Stars, type Review } from '../lib/reviews'
import { basketCount, basketSubtotal, setQty, useBasket } from '../lib/basket'
import { pounds, type Allergen, type Presence, type Product, type Shop, type ShopSettings } from '../lib/types'

type AllergenRow = { product_id: string; allergen_code: string; presence: Presence }

type Loaded = {
  shop: Shop
  settings: ShopSettings | null
  products: Product[]
  allergens: Allergen[]
  rows: AllergenRow[]
  photos: Record<string, string>
  hours: { weekday: number; opens: string; closes: string }[]
  closedToday: boolean
  reviews: Review[]
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Groups days with the same hours: "Mon–Fri 10:00–18:00 · Sat 11:00–15:00".
function hoursSummary(hours: Loaded['hours']) {
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    const t = `${sorted[i].opens.slice(0, 5)}–${sorted[i].closes.slice(0, 5)}`
    while (j + 1 < sorted.length && sorted[j + 1].weekday === sorted[j].weekday + 1 &&
           `${sorted[j + 1].opens.slice(0, 5)}–${sorted[j + 1].closes.slice(0, 5)}` === t) j++
    const days = i === j ? DAY_SHORT[sorted[i].weekday] : `${DAY_SHORT[sorted[i].weekday]}–${DAY_SHORT[sorted[j].weekday]}`
    parts.push(`${days} ${t}`)
    i = j + 1
  }
  return parts.join(' · ')
}

// The shareable shop page at /s/<slug>. Visitors see live shops only; the
// owner can also preview their own shop before it goes live.
export default function PublicShop({ slug }: { slug: string }) {
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined)
  const basket = useBasket()

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: shop } = await db.from('shops').select('*').eq('slug', slug).maybeSingle()
      if (!shop) return setLoaded(null)
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
      const [s, p, a, h, c, r] = await Promise.all([
        db.from('shop_settings').select('*').eq('shop_id', shop.id).maybeSingle(),
        db.from('products').select('*').eq('shop_id', shop.id).neq('status', 'archived').order('created_at'),
        db.from('allergens').select('code, name'),
        db.from('shop_hours').select('weekday, opens, closes').eq('shop_id', shop.id),
        db.from('shop_closures').select('id').eq('shop_id', shop.id).eq('closed_on', today),
        db.from('reviews').select('*').eq('shop_id', shop.id).eq('hidden', false).order('created_at', { ascending: false }).limit(30),
      ])
      const products: Product[] = p.data ?? []
      const { data: rows } = products.length
        ? await db
            .from('product_allergens')
            .select('product_id, allergen_code, presence')
            .in('product_id', products.map((x) => x.id))
            .is('variant_id', null)
            .is('addon_id', null)
        : { data: [] }
      const { data: images } = products.length
        ? await db.from('product_images').select('product_id, path, sort').in('product_id', products.map((x) => x.id)).order('sort')
        : { data: [] }
      const photos: Record<string, string> = {}
      for (const img of images ?? []) photos[img.product_id] ??= img.path
      setLoaded({
        shop, settings: s.data, products, allergens: a.data ?? [], rows: rows ?? [], photos,
        hours: h.data ?? [], closedToday: (c.data ?? []).length > 0, reviews: r.data ?? [],
      })
    })()
  }, [slug])

  useEffect(() => {
    if (loaded) document.title = `${loaded.shop.name} · Homemade Food`
    return () => {
      document.title = 'Homemade Food'
    }
  }, [loaded])

  if (loaded === undefined) return <p className="muted">Loading…</p>
  if (loaded === null) {
    return (
      <div className="card">
        <h2>Shop not found</h2>
        <p className="muted">This shop doesn't exist or isn't open yet.</p>
      </div>
    )
  }

  const { shop, settings, products, allergens, rows, photos, hours, closedToday, reviews } = loaded
  const average = reviews.length ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length : 0
  const name = (code: string) => allergens.find((a) => a.code === code)?.name ?? code
  const isPreview = shop.status !== 'live'
  const canOrder = !isPreview && shop.accepting_orders
  const qtyOf = (id: string) => (basket?.shopId === shop.id ? basket.lines.find((l) => l.productId === id)?.qty ?? 0 : 0)
  const options = [settings?.offers_collection && 'Collection', settings?.offers_delivery && 'Delivery'].filter(Boolean)

  return (
    <div className="stack">
      {isPreview && (
        <p className="status">Preview: only you can see this until your shop goes live.</p>
      )}
      {shop.cover_path && <img className="cover hero" src={photoUrl(shop.cover_path)!} alt="" />}
      <div className="shop-head">
        {shop.logo_path && <img className="logo" src={photoUrl(shop.logo_path)!} alt="" />}
        <div>
        <h1>{shop.name}</h1>
        <p className="muted">
          {[shop.area_label, ...shop.cuisines].filter(Boolean).join(' · ')}
        </p>
        {options.length > 0 && <p className="muted small">{options.join(' or ')}</p>}
        {hours.length > 0 && <p className="muted small">{hoursSummary(hours)}</p>}
        {reviews.length > 0 && (
          <p className="small"><a href="#reviews"><Stars value={average} size="small" /> {average.toFixed(1)} ({reviews.length})</a></p>
        )}
        </div>
      </div>
      {closedToday && <p className="status">Closed today.</p>}
      {shop.story && <p className="story">{shop.story}</p>}

      <h2>Menu</h2>
      {products.length === 0 && <p className="muted">Nothing on the menu yet.</p>}
      {products.map((p) => {
        const mine = rows.filter((r) => r.product_id === p.id)
        const contains = mine.filter((r) => r.presence === 'contains').map((r) => name(r.allergen_code))
        const mayContain = mine.filter((r) => r.presence === 'may_contain').map((r) => name(r.allergen_code))
        return (
          <article key={p.id} className="card">
            {photos[p.id] && <img className="dish" src={photoUrl(photos[p.id])!} alt={p.name} loading="lazy" />}
            <div className="item">
              <strong>{p.name}</strong>
              <span>{pounds(p.price_pence)}</span>
            </div>
            {p.status !== 'published' && <span className="pill pill-draft">Draft, not visible to customers</span>}
            {p.portion && <p className="muted small">{p.portion}</p>}
            {p.description && <p>{p.description}</p>}
            {canOrder && p.status === 'published' && (
              <div className="qty">
                {qtyOf(p.id) > 0 ? (
                  <>
                    <button type="button" className="secondary small-btn" aria-label="One less" onClick={() => setQty(shop, { productId: p.id, name: p.name, pricePence: p.price_pence }, qtyOf(p.id) - 1)}>−</button>
                    <span>{qtyOf(p.id)}</span>
                    <button type="button" className="secondary small-btn" aria-label="One more" onClick={() => setQty(shop, { productId: p.id, name: p.name, pricePence: p.price_pence }, qtyOf(p.id) + 1)}>+</button>
                  </>
                ) : (
                  <button type="button" className="small-btn" onClick={() => setQty(shop, { productId: p.id, name: p.name, pricePence: p.price_pence }, 1)}>Add</button>
                )}
              </div>
            )}
            <details>
              <summary>Ingredients and allergens</summary>
              {p.ingredients && <p className="small">{p.ingredients}</p>}
              <p className="small">
                <strong>Contains:</strong> {contains.length ? contains.join(', ') : 'none of the 14 main allergens'}
              </p>
              {mayContain.length > 0 && (
                <p className="small"><strong>May contain:</strong> {mayContain.join(', ')}</p>
              )}
              {p.may_contain_notes && <p className="small muted">{p.may_contain_notes}</p>}
            </details>
          </article>
        )
      })}
      {reviews.length > 0 && (
        <section id="reviews" className="stack">
          <h2>Reviews</h2>
          {reviews.map((r) => <ReviewItem key={r.id} review={r} />)}
        </section>
      )}
      {!isPreview && !shop.accepting_orders && <p className="status">This shop isn't taking orders right now.</p>}
      <p className="muted small">
        Have an allergy? Check the allergen list for each item and contact the seller before
        ordering if you are unsure.
      </p>
      {basket?.shopId === shop.id && basketCount(basket) > 0 && (
        <a className="button basket-bar" href="/basket" onClick={link('/basket')}>
          View basket · {basketCount(basket)} {basketCount(basket) === 1 ? 'item' : 'items'} · {pounds(basketSubtotal(basket))}
        </a>
      )}
    </div>
  )
}
