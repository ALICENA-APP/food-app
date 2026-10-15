import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { pounds, type Allergen, type Presence, type Product, type Shop, type ShopSettings } from '../lib/types'

type AllergenRow = { product_id: string; allergen_code: string; presence: Presence }

type Loaded = {
  shop: Shop
  settings: ShopSettings | null
  products: Product[]
  allergens: Allergen[]
  rows: AllergenRow[]
}

// The shareable shop page at /s/<slug>. Visitors see live shops only; the
// owner can also preview their own shop before it goes live.
export default function PublicShop({ slug }: { slug: string }) {
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: shop } = await db.from('shops').select('*').eq('slug', slug).maybeSingle()
      if (!shop) return setLoaded(null)
      const [s, p, a] = await Promise.all([
        db.from('shop_settings').select('*').eq('shop_id', shop.id).maybeSingle(),
        db.from('products').select('*').eq('shop_id', shop.id).neq('status', 'archived').order('created_at'),
        db.from('allergens').select('code, name'),
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
      setLoaded({ shop, settings: s.data, products, allergens: a.data ?? [], rows: rows ?? [] })
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

  const { shop, settings, products, allergens, rows } = loaded
  const name = (code: string) => allergens.find((a) => a.code === code)?.name ?? code
  const isPreview = shop.status !== 'live'
  const options = [settings?.offers_collection && 'Collection', settings?.offers_delivery && 'Delivery'].filter(Boolean)

  return (
    <div className="stack">
      {isPreview && (
        <p className="status">Preview: only you can see this until your shop goes live.</p>
      )}
      <div>
        <h1>{shop.name}</h1>
        <p className="muted">
          {[shop.area_label, ...shop.cuisines].filter(Boolean).join(' · ')}
        </p>
        {options.length > 0 && <p className="muted small">{options.join(' or ')}</p>}
      </div>
      {shop.story && <p className="story">{shop.story}</p>}

      <h2>Menu</h2>
      {products.length === 0 && <p className="muted">Nothing on the menu yet.</p>}
      {products.map((p) => {
        const mine = rows.filter((r) => r.product_id === p.id)
        const contains = mine.filter((r) => r.presence === 'contains').map((r) => name(r.allergen_code))
        const mayContain = mine.filter((r) => r.presence === 'may_contain').map((r) => name(r.allergen_code))
        return (
          <article key={p.id} className="card">
            <div className="item">
              <strong>{p.name}</strong>
              <span>{pounds(p.price_pence)}</span>
            </div>
            {p.status !== 'published' && <span className="pill pill-draft">Draft, not visible to customers</span>}
            {p.portion && <p className="muted small">{p.portion}</p>}
            {p.description && <p>{p.description}</p>}
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
      <p className="muted small">
        Ordering opens soon. Have an allergy? Check the allergen list for each item and contact the
        seller before ordering if you are unsure.
      </p>
    </div>
  )
}
