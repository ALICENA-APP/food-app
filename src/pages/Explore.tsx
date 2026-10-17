import { lazy, Suspense, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate, queryParam } from '../lib/router'
import { Icon } from '../lib/icons'
import { dishQuery, loadFeatured, loadRatings, loadShopOptions, useCategories, type Dish, type Rating } from '../lib/catalogue'
import { loadOpenStates, type OpenState } from '../lib/hours'
import { loadDeliveryTo, loadNear, postcodeDistrict, usePostcode, type Near } from '../lib/postcode'
import { PostcodePicker } from '../lib/PostcodePicker'
import { CategoryIcon } from '../lib/categoryIcons'
import { freeFrom, useAllergenHits, useMyAllergies } from '../lib/allergies'
import { useOrderCounts } from '../lib/popular'
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

const ShopMap = lazy(() => import('../lib/ShopMap'))

type Sort = 'new' | 'nearest' | 'rated' | 'popular' | 'price'
const SORTS: { key: Sort; label: string }[] = [
  { key: 'new', label: 'Newest' },
  { key: 'nearest', label: 'Nearest' },
  { key: 'rated', label: 'Top rated' },
  { key: 'popular', label: 'Most ordered' },
  { key: 'price', label: 'Lowest price' },
]

type ShopRow = ShopCardData & { accepting_orders: boolean }

// Search and filters across every dish and seller.
export default function Explore() {
  const categories = useCategories()
  const [query, setQuery] = useState(queryParam('q'))
  const [category, setCategory] = useState(queryParam('c'))
  const [view, setView] = useState<'items' | 'sellers' | 'map'>(queryParam('view') === 'sellers' ? 'sellers' : queryParam('view') === 'map' ? 'map' : 'items')
  const [filters, setFilters] = useState<Filter[]>(queryParam('diet') ? [queryParam('diet') as Filter] : [])
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [shops, setShops] = useState<ShopRow[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [open, setOpen] = useState<Record<string, OpenState>>({})
  const [postcode, , point] = usePostcode()
  const [near, setNear] = useState<Record<string, Near>>({})
  const [within, setWithin] = useState(0)
  const district = postcode ? postcodeDistrict(postcode) : ''
  const [delivers, setDelivers] = useState<Record<string, number>>({})
  const [featured, setFeatured] = useState<string[]>([])
  const [options, setOptions] = useState<Record<string, { collection: boolean; delivery: boolean }>>({})
  const [sort, setSort] = useState<Sort>('new')
  const mine = useMyAllergies()
  const [ignoreAllergies, setIgnoreAllergies] = useState(false)
  const dishIds = (dishes ?? []).map((d) => d.id)
  const hits = useAllergenHits(dishIds, mine.codes)
  const orderCounts = useOrderCounts(dishIds)
  const allergyFilter = mine.codes.length > 0 && !ignoreAllergies

  useEffect(() => {
    ;(async () => {
      const [d, s] = await Promise.all([
        dishQuery().order('created_at', { ascending: false }).limit(300),
        supabase!.from('shops').select('id, name, slug, logo_path, area_label, cuisines, accepting_orders, is_demo').eq('status', 'live').limit(200),
      ])
      loadFeatured().then(setFeatured)
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
  useEffect(() => {
    loadNear(point).then(setNear)
  }, [point])

  // Keep the address bar in step so the back button and shared links work.
  useEffect(() => {
    const params = new URLSearchParams()
    if (query.trim()) params.set('q', query.trim())
    if (category) params.set('c', category)
    if (view !== 'items') params.set('view', view)
    const qs = params.toString()
    navigate(`/explore${qs ? `?${qs}` : ''}`, true)
  }, [query, category, view])

  const toggle = (f: Filter) => setFilters(filters.includes(f) ? filters.filter((x) => x !== f) : [...filters, f])
  const has = (f: Filter) => filters.includes(f)
  const q = query.trim().toLowerCase()
  const categoryId = categories.find((c) => c.slug === category)?.id

  const shopOk = (id: string, accepting: boolean) =>
    (!has('delivery') || (options[id]?.delivery && (!district || delivers[id] !== undefined || near[id]?.delivers))) &&
    (!within || (near[id] && near[id].miles <= within)) &&
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
    (!allergyFilter || freeFrom(hits, d.id, mine.strict)) &&
    shopOk(d.shop_id, d.shops.accepting_orders))
  const miles = (d: Dish) => near[d.shop_id]?.miles ?? 99
  const sortedDishes = sort === 'new' ? shownDishes : [...shownDishes].sort((a, b) =>
    sort === 'nearest' ? miles(a) - miles(b)
      : sort === 'rated' ? (ratings[b.shop_id]?.average ?? 0) - (ratings[a.shop_id]?.average ?? 0)
        : sort === 'popular' ? (orderCounts[b.id] ?? 0) - (orderCounts[a.id] ?? 0)
          : a.price_pence - b.price_pence)

  const withDishes = new Set(shownDishes.map((d) => d.shop_id))
  const dishFilterOn = Boolean(categoryId) || allergyFilter || ['under10', 'vegetarian', 'vegan', 'halal'].some((f) => has(f as Filter))
  // Up to three featured cooks go first, labelled Sponsored; the rest by distance.
  const pinned = new Set(featured.slice(0, 3))
  const shownShops = [...shops].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || (near[a.id]?.miles ?? 99) - (near[b.id]?.miles ?? 99)).filter((s) =>
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
      <PostcodePicker />
      {point && (
        <div className="chips">
          {[0, 1, 2, 3, 5].map((m) => (
            <button key={m} type="button" className={`chip ${within === m ? 'on' : ''}`} onClick={() => setWithin(m)}>
              {m ? `Within ${m} mi` : 'Any distance'}
            </button>
          ))}
        </div>
      )}
      <div className="chips">
        {mine.codes.length > 0 ? (
          <button type="button" className={`chip ${allergyFilter ? 'on' : ''}`} onClick={() => setIgnoreAllergies(!ignoreAllergies)}>
            <Icon name="leaf" size={16} /> Free from my allergies
          </button>
        ) : (
          <a className="chip" href="/my-allergies" onClick={link('/my-allergies')}><Icon name="leaf" size={16} /> Allergies?</a>
        )}
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
        <label className={view === 'map' ? 'on' : ''}>
          <input type="radio" checked={view === 'map'} onChange={() => setView('map')} />
          Map
        </label>
      </div>

      {dishes === null && <p className="muted">Loading…</p>}
      {dishes && view === 'items' && shownDishes.length > 0 && (
        <div className="sort-row">
          <span className="muted small">{allergyFilter && hits === null ? 'Checking allergens…' : allergyFilter ? `Hiding dishes with your allergens${mine.strict ? ' (and may contain)' : ''}` : ''}</span>
          <select aria-label="Sort dishes" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            {SORTS.filter((s) => s.key !== 'nearest' || point).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
      )}
      {dishes && view === 'items' && (shownDishes.length ? (
        <div className="grid2">
          {sortedDishes.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} orders={orderCounts[d.id]} />)}
        </div>
      ) : <NothingFound empty={dishes.length === 0} />)}
      {dishes && view === 'map' && (
        <Suspense fallback={<p className="muted">Loading map…</p>}>
          <ShopMap shops={shownShops} me={point} />
        </Suspense>
      )}
      {dishes && view === 'sellers' && (shownShops.length ? (
        <div className="stack" style={{ gap: 10 }}>
          {shownShops.map((s) => <SellerRow key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} miles={near[s.id]?.miles} sponsored={pinned.has(s.id)} />)}
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
