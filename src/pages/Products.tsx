import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { pounds, type Product, type Shop } from '../lib/types'

const STATUS_LABEL: Record<Product['status'], string> = {
  draft: 'Draft',
  published: 'On sale',
  archived: 'Hidden',
}

export default function Products() {
  const [shop, setShop] = useState<Shop | null | undefined>(undefined)
  const [products, setProducts] = useState<Product[]>([])

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').maybeSingle()
      if (!account) return setShop(null)
      const { data: shops } = await db.from('shops').select('*').eq('seller_account_id', account.id).limit(1)
      const s = shops?.[0] ?? null
      setShop(s)
      if (s) {
        const { data } = await db.from('products').select('*').eq('shop_id', s.id).order('created_at')
        setProducts(data ?? [])
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

  return (
    <div className="stack">
      <p>
        <a href="/sell" onClick={link('/sell')}>← Seller account</a>
      </p>
      <h1>{shop.name}: menu</h1>
      <a className="button" href="/sell/products/new" onClick={link('/sell/products/new')}>
        Add an item
      </a>
      {products.length === 0 && <p className="muted">No items yet.</p>}
      {products.map((p) => (
        <a key={p.id} className="card item" href={`/sell/products/${p.id}`} onClick={link(`/sell/products/${p.id}`)}>
          <div>
            <strong>{p.name}</strong>
            <span className="muted"> · {pounds(p.price_pence)}</span>
          </div>
          <span className={`pill pill-${p.status}`}>{STATUS_LABEL[p.status]}</span>
        </a>
      ))}
      <p className="muted small">
        Preview your shop: <a href={`/s/${shop.slug}`} onClick={link(`/s/${shop.slug}`)}>food.beastcase.net/s/{shop.slug}</a>
      </p>
    </div>
  )
}
