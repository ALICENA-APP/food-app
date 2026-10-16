import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { FoodPhoto } from '../lib/ui'
import { pounds, type Product, type Shop } from '../lib/types'

const STATUS_LABEL: Record<Product['status'], string> = {
  draft: 'Draft',
  published: 'On sale',
  archived: 'Hidden',
}

// The seller's menu, with quick switches for sold out and portions left.
export default function Products() {
  const [shop, setShop] = useState<Shop | null | undefined>(undefined)
  const [products, setProducts] = useState<Product[]>([])
  const [photos, setPhotos] = useState<Record<string, string>>({})

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').maybeSingle()
      if (!account) return setShop(null)
      const { data: shops } = await db.from('shops').select('*').eq('seller_account_id', account.id).limit(1)
      const s = shops?.[0] ?? null
      setShop(s)
      if (s) {
        const { data } = await db.from('products').select('*').eq('shop_id', s.id).neq('status', 'archived').order('created_at')
        setProducts(data ?? [])
        const ids = (data ?? []).map((p) => p.id)
        if (ids.length) {
          const { data: imgs } = await db.from('product_images').select('product_id, path, sort').in('product_id', ids).order('sort')
          const first: Record<string, string> = {}
          for (const i of imgs ?? []) first[i.product_id] ??= i.path
          setPhotos(first)
        }
      }
    })()
  }, [])

  if (shop === undefined) return <p className="muted">Loading…</p>
  if (!shop) {
    return (
      <div className="card">
        <p>Set up your shop first.</p>
        <a className="button" href="/sell/shop" onClick={link('/sell/shop')}>Set up shop</a>
      </div>
    )
  }

  const replace = (p: Product) => setProducts((list) => list.map((x) => (x.id === p.id ? p : x)))

  return (
    <div className="stack">
      <a className="back" href="/sell" onClick={link('/sell')}><Icon name="back" size={18} /> Your shop</a>
      <div className="section-head">
        <h1>Menu</h1>
        <a className="button small-btn" href="/sell/products/new" onClick={link('/sell/products/new')}><Icon name="plus" size={16} /> Add a dish</a>
      </div>
      {products.length === 0 && (
        <div className="card empty">
          <span className="big">🍲</span>
          <p>No dishes yet. Add your first one: a name, price, photo and the 14 allergens.</p>
        </div>
      )}
      {products.map((p) => <MenuItem key={p.id} product={p} photo={photos[p.id] ?? null} onChange={replace} />)}
      <p className="muted small">
        Preview your shop: <a href={`/s/${shop.slug}`} onClick={link(`/s/${shop.slug}`)}>food.beastcase.net/s/{shop.slug}</a>
      </p>
    </div>
  )
}

function MenuItem({ product: p, photo, onChange }: { product: Product; photo: string | null; onChange: (p: Product) => void }) {
  const [portions, setPortions] = useState(p.stock_qty === null ? '' : String(p.stock_qty))
  const [error, setError] = useState('')
  const soldOut = p.stock_qty === 0

  async function setStock(stock: number | null) {
    setError('')
    const { error: err } = await supabase!.from('products').update({ stock_qty: stock }).eq('id', p.id)
    if (err) return setError(err.message)
    setPortions(stock === null ? '' : String(stock))
    onChange({ ...p, stock_qty: stock })
  }

  return (
    <div className="card" style={{ gap: 10 }}>
      <a className={`menu-row bare ${soldOut ? 'sold-out' : ''}`} href={`/sell/products/${p.id}`} onClick={link(`/sell/products/${p.id}`)}>
        <span className="ph"><FoodPhoto path={photo} alt={p.name} /></span>
        <span className="info">
          <strong>{p.name}</strong>
          <span className="muted small">{pounds(p.price_pence)}{p.portion ? ` · ${p.portion}` : ''}</span>
          <span className="tags">
            <span className={`tag ${p.status === 'published' ? 'green' : 'grey'}`}>{STATUS_LABEL[p.status]}</span>
            {soldOut && <span className="tag red">Sold out</span>}
          </span>
        </span>
        <Icon name="edit" size={20} />
      </a>
      {p.status === 'published' && (
        <>
          <label className="switch-row">
            <span>
              <strong>{soldOut ? 'Sold out' : 'Available'}</strong>
              <span className="muted small" style={{ display: 'block' }}>
                {soldOut ? 'Customers can see it but can’t order it.' : p.stock_qty ? `${p.stock_qty} left, then it shows as sold out.` : 'No limit on portions.'}
              </span>
            </span>
            <input type="checkbox" className="switch" checked={!soldOut} onChange={() => setStock(soldOut ? null : 0)} aria-label={`${p.name} available`} />
          </label>
          {!soldOut && (
            <form className="row" style={{ alignItems: 'center' }} onSubmit={(e) => { e.preventDefault(); setStock(portions === '' ? null : Math.max(0, Math.min(10000, parseInt(portions, 10) || 0))) }}>
              <input type="number" min={0} max={10000} inputMode="numeric" value={portions} onChange={(e) => setPortions(e.target.value)} placeholder="No limit" aria-label="Portions left" />
              <button type="submit" className="secondary small-btn">Set portions left</button>
            </form>
          )}
        </>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
