import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { navigate, queryParam } from '../lib/router'
import { Icon } from '../lib/icons'
import { dishQuery, loadRatings, loadShopOptions, useCategories, type Dish, type Rating } from '../lib/catalogue'
import { loadOpenStates, type OpenState } from '../lib/hours'
import { loadDeliveryTo, postcodeDistrict, usePostcode } from '../lib/postcode'
import { CategoryIcon } from '../lib/categoryIcons'
import { DishCard, SellerRow, type ShopCardData } from '../lib/ui'

type Filter = 'delivery' | 'collection' | 'rated' | 'under10' | 'vegetarian' | 'vegan' | 'halal' | 'open'
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'delivery', label: 'Delivery' },
  { key: 'collection', label: 'Collection' },
  { key: 'rated', label: 'Rating 4.5+' },
  { key: 'under10', label: 'Under £10' },
  { key: 'vegetarian', label: 'Vegetarian' },
  { key: 'vegan', label: 'Vegan' },
  { key: 'halal', label: 'Halal' },
  { key: 'open', label: 'Open now' },
]

type ShopRow = ShopCardData & { accepting_orders: boolean }

// Search and filters across every dish and seller.
export default function Explore() {
  const categories = useCategories()
  const [query, setQuery] = useState(queryParam('q'))
  const [category, setCategory] = useState(queryParam('c'))
  const [view, setView] = useState<'items' | 'sellers'>(queryParam('view') === 'sellers' ? 'sellers' : 'items')
  const [filters, setFilters] = useState<Filter[]>(queryParam('diet') ? [queryParam('diet') as Filter] : [])
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [shops, setShops] = useState<ShopRow[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [open, setOpen] = useState<Record<string, OpenState>>({})
  const [postcode] = usePostcode()
  const district = postcode ? postcodeDistrict(postcode) : ''
  const [delivers, setDelivers] = useState<Record<string, number>>({})
  const [options, setOptions] = useState<Record<string, { collection: boolean; delivery: boolean }>>({})

  useEffect(() => {
    ;(async () => {
      const [d, s] = await Promise.all([
        dishQuery().order('created_at', { ascending: false }).limit(300),
        supabase!.from('shops').select('id, name, slug, logo_path, area_label, cuisines, accepting_orders').eq('status', 'live').limit(200),
      ])
      setDishes((d.data ?? []) as unknown as Dish[])
      setShops(s.data ?? [])
      const ids = (s.data ?? []).map((x) => x.id)
      const [r, o, h] = await Promise.all([loadRatings(ids), loadShopOptions(ids), loadOpenStates(ids)])
      setRatings(r)
      setOptions(o)
      setOpen(h)
    })()
  }, [])

  useEffect(() => {
    loadDeliveryTo(shops.map((x) => x.id), district).then(setDelivers)
  }, [shops, district])

  // Keep the address bar in step so the back button and shared links work.
  useEffect(() => {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (category) params.set('c', category)
    if (view === 'sellers') params.set('view', 'sellers')
    const qs = params.toString()
    navigate(`/explore${qs ? `?${qs}` : ''}`, true)
  }, [query, category, view])

  const toggle = (f: Filter) => setFilters(filters.includes(f) ? filters.filter((x) => x !== f) : [...filters, f])
  const has = (f: Filter) => filters.includes(f)
  const q = query.trim().toLowerCase()
  const categoryId = categories.find((c) => c.slug === category)?.id

  const shopOk = (id: string, accepting: boolean) =>
    (!has('delivery') || (options[id]?.delivery && (!district || delivers[id] !== undefined))) &&
    (!has('collection') || options[id]?.collection !== false) &&
    (!has('rated') || (ratings[id]?.average ?? 0) >= 4.5) &&
    (!has('open') || (accepting && open[id]?.open !== false))

  const shownDishes = (dishes ?? []).filter((d) =>
    (!q || [d.name, d.description ?? '', d.shops.name].some((t) => t.toLowerCase().includes(q))) &&
    (!categoryId || d.category_id === categoryId) &&
    (!has('under10') || d.price_pence < 1000) &&
    (!has('vegetarian') || d.dietary.includes('vegetarian') || d.dietary.includes('vegan')) &&
    (!has('vegan') || d.dietary.includes('vegan')) &&
    (!has('halal') || d.dietary.includes('halal')) &&
    (!has('delivery') || d.delivery_ok) &&
    (!has('collection') || d.collection_ok) &&
    shopOk(d.shop_id, d.shops.accepting_orders))

  const withDishes = new Set(shownDishes.map((d) => d.shop_id))
  const dishFilterOn = Boolean(categoryId) || ['under10', 'vegetarian', 'vegan', 'halal'].some((f) => has(f as Filter))
  const shownShops = shops.filter((s) =>
    (!q || [s.name, s.area_label ?? '', ...s.cuisines].some((t) => t.toLowerCase().includes(q)) || withDishes.has(s.id)) &&
    (!dishFilterOn || withDishes.has(s.id)) &&
    shopOk(s.id, s.accepting_orders))

  return (
    <div className="stack">
      <h1>Explore</h1>
      <form className="search" onSubmit={(e) => e.preventDefault()} role="search">
        <Icon name="search" />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes, cooks or cuisines" aria-label="Search" />
      </form>
      <div className="chips">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className={`chip ${has(f.key) ? 'on' : ''}`} onClick={() => toggle(f.key)}>
            {['vegetarian', 'vegan', 'halal'].includes(f.key) && <span className="chip-ic"><CategoryIcon slug={f.key} /></span>}
            {f.key === 'delivery' && district ? `Delivers to ${district}` : f.label}
          </button>
        ))}
      </div>
      <div className="chips">
        <button type="button" className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory('')}>All food</button>
        {categories.map((c) => (
          <button key={c.id} type="button" className={`chip ${category === c.slug ? 'on' : ''}`} onClick={() => setCategory(category === c.slug ? '' : c.slug)}><span className="chip-ic"><CategoryIcon slug={c.slug} /></span>{c.name}</button>
        ))}
      </div>
      <div className="segmented">
        <label className={view === 'items' ? 'on' : ''}>
          <input type="radio" checked={view === 'items'} onChange={() => setView('items')} />
          Dishes ({shownDishes.length})
        </label>
        <label className={view === 'sellers' ? 'on' : ''}>
          <input type="radio" checked={view === 'sellers'} onChange={() => setView('sellers')} />
          Sellers ({shownShops.length})
        </label>
      </div>

      {dishes === null && <p className="muted">Loading…</p>}
      {dishes && view === 'items' && (shownDishes.length ? (
        <div className="grid2">
          {shownDishes.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} />)}
        </div>
      ) : <NothingFound empty={dishes.length === 0} />)}
      {dishes && view === 'sellers' && (shownShops.length ? (
        <div className="stack" style={{ gap: 10 }}>
          {shownShops.map((s) => <SellerRow key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} />)}
        </div>
      ) : <NothingFound empty={shops.length === 0} />)}
    </div>
  )
}

function NothingFound({ empty }: { empty: boolean }) {
  return (
    <div className="empty">
      <span className="big">{empty ? '👩🏾‍🍳' : '🔍'}</span>
      <p>{empty ? 'The first cooks are getting ready. Check back soon.' : 'Nothing matches. Try fewer filters or another search.'}</p>
    </div>
  )
}
