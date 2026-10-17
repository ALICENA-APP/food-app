import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { Icon } from '../lib/icons'
import { dishQuery, loadFeatured, loadRatings, useCategories, type Dish, type Rating } from '../lib/catalogue'
import { useOrderCounts } from '../lib/popular'
import { loadOpenStates, type OpenState } from '../lib/hours'
import { InstallPrompt } from '../lib/install'
import { PostcodePicker } from '../lib/PostcodePicker'
import { CategoryIcon } from '../lib/categoryIcons'
import { WaitlistCard } from '../lib/waitlist'
import { loadDeliveryTo, loadNear, postcodeDistrict, usePostcode, type Near } from '../lib/postcode'
import { BowlArt, DishCard, FoodPhoto, SellerCard, type ShopCardData } from '../lib/ui'
import { readRecent } from '../lib/views'
import { pounds } from '../lib/types'
import { useCommission } from '../lib/platform'

// The first screen everyone sees, signed in or not.
export default function Home() {
  const categories = useCategories()
  const commission = useCommission()
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const orderCounts = useOrderCounts((dishes ?? []).map((d) => d.id))
  const [shops, setShops] = useState<ShopCardData[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, OpenState>>({})
  const [postcode, , point] = usePostcode()
  const [near, setNear] = useState<Record<string, Near>>({})
  const [delivers, setDelivers] = useState<Record<string, number>>({})
  const [featured, setFeatured] = useState<string[]>([])
  const [recent] = useState(readRecent)

  useEffect(() => {
    ;(async () => {
      const [d, s, f] = await Promise.all([
        dishQuery().order('created_at', { ascending: false }).limit(60),
        supabase!.from('shops').select('id, name, slug, logo_path, area_label, cuisines, is_demo').eq('status', 'live').limit(60),
        loadFeatured(),
      ])
      setFeatured(f)
      const list = (d.data ?? []) as unknown as Dish[]
      setDishes(list)
      setShops(s.data ?? [])
      const ids = (s.data ?? []).map((x) => x.id)
      const [r, o] = await Promise.all([loadRatings(ids), loadOpenStates(ids)])
      setRatings(r)
      setOpen(o)
    })()
  }, [])

  const district = postcode ? postcodeDistrict(postcode) : ''
  useEffect(() => {
    loadDeliveryTo(shops.map((x) => x.id), district).then(setDelivers)
  }, [shops, district])
  useEffect(() => {
    loadNear(point).then(setNear)
  }, [point])

  function search(e: FormEvent) {
    e.preventDefault()
    navigate(`/explore${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
  }

  const desserts = categories.filter((c) => ['desserts', 'cakes-bakes'].includes(c.slug)).map((c) => c.id)
  const rated = (shopId: string) => ratings[shopId]?.average ?? 0
  // With a postcode set, shops that deliver there come first.
  // With a postcode set, cooks who deliver there come first, then the nearest.
  const reach = (shopId: string) => (delivers[shopId] !== undefined || near[shopId]?.delivers ? 1 : 0)
  const away = (shopId: string) => near[shopId]?.miles ?? 99
  const closer = (a: string, b: string) => reach(b) - reach(a) || away(a) - away(b)
  const ordered = (id: string) => orderCounts[id] ?? 0
  const popular = [...(dishes ?? [])].sort((a, b) => closer(a.shop_id, b.shop_id) || ordered(b.id) - ordered(a.id) || rated(b.shop_id) - rated(a.shop_id)).slice(0, 10)
  const sweet = (dishes ?? []).filter((d) => d.category_id && desserts.includes(d.category_id)).slice(0, 10)
  const featuredShops = featured.map((id) => shops.find((x) => x.id === id)).filter((x): x is ShopCardData => Boolean(x))
  const topShops = [...shops].sort((a, b) => (point ? closer(a.id, b.id) : 0) || rated(b.id) - rated(a.id) || (ratings[b.id]?.reviews ?? 0) - (ratings[a.id]?.reviews ?? 0)).slice(0, 10)

  return (
    <div className="stack-lg">
      <div className="stack">
        <PostcodePicker />
        <form className="search" onSubmit={search} role="search">
          <Icon name="search" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes, cooks or cuisines" aria-label="Search" />
        </form>
      </div>

      <div className="cat-row" role="list">
        <CatTile slug="all" name="All" to="/explore" />
        {categories.map((c) => <CatTile key={c.id} slug={c.slug} name={shortName(c.name)} to={`/explore?c=${c.slug}`} />)}
        <CatTile slug="halal" name="Halal" to="/explore?diet=halal" />
        <CatTile slug="vegetarian" name="Vegetarian" to="/explore?diet=vegetarian" />
        <CatTile slug="vegan" name="Vegan" to="/explore?diet=vegan" />
      </div>

      {featuredShops.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <span className="featured-head"><h2>Featured cooks</h2><span className="muted tiny">Sponsored</span></span>
            <a href="/explore?view=sellers" onClick={link('/explore?view=sellers')}>See all</a>
          </div>
          <div className="hscroll">
            {featuredShops.map((s) => <SellerCard key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} miles={near[s.id]?.miles} sponsored />)}
          </div>
        </section>
      )}

      <InstallPrompt />

      <section className="hero">
        <span className="kicker">Homemade · Local · Fresh</span>
        <h2>Real food. Real people.</h2>
        <p>Order homemade food from cooks in your neighbourhood.</p>
        <a className="button dark" href="/explore?view=sellers" onClick={link('/explore?view=sellers')}>Browse local sellers</a>
        <BowlArt />
      </section>

      {dishes === null && <p className="muted">Loading…</p>}

      {postcode && point && dishes !== null && !shops.some((s) => !s.is_demo && (delivers[s.id] !== undefined || near[s.id]?.delivers || (near[s.id]?.miles ?? 99) <= 10)) && (
        <WaitlistCard postcode={postcode} />
      )}

      {dishes && dishes.length === 0 && (
        <section className="card empty">
          <span className="big">👩🏾‍🍳</span>
          <h2 style={{ color: 'var(--text)' }}>The first cooks are getting ready</h2>
          <p>BiteBY is opening near you soon. Have a look around, and check back for the first menus.</p>
        </section>
      )}

      {popular.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <h2>Popular near you</h2>
            <a href="/explore" onClick={link('/explore')}>See all</a>
          </div>
          <div className="hscroll">
            {popular.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} orders={orderCounts[d.id]} />)}
          </div>
        </section>
      )}

      {topShops.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <h2>{point ? 'Cooks near you' : 'Top rated sellers'}</h2>
            <a href="/explore?view=sellers" onClick={link('/explore?view=sellers')}>See all</a>
          </div>
          <div className="hscroll">
            {topShops.map((s) => <SellerCard key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} miles={near[s.id]?.miles} />)}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="stack">
          <div className="section-head"><h2>Recently viewed</h2></div>
          <div className="hscroll">
            {recent.map((d) => {
              const to = `/s/${d.slug}/i/${d.id}`
              return (
                <a key={d.id} className="dish-card small" href={to} onClick={link(to)}>
                  <span className="ph"><FoodPhoto path={d.photo} alt={d.name} /></span>
                  <span className="body"><span className="name">{d.name}</span><span className="by">{d.shopName}</span><span className="price">{pounds(d.pricePence)}</span></span>
                </a>
              )
            })}
          </div>
        </section>
      )}

      {sweet.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <h2>Fresh desserts</h2>
            <a href="/explore?c=desserts" onClick={link('/explore?c=desserts')}>See all</a>
          </div>
          <div className="hscroll">
            {sweet.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} orders={orderCounts[d.id]} />)}
          </div>
        </section>
      )}

      <section className="promo">
        <h2>Cook at home? Sell on BiteBY</h2>
        <p>Open your own food shop with a link you can share. No monthly fee: we take {commission} of the food price only when you sell.</p>
        <a className="button dark" href="/sell" onClick={link('/sell')}>Become a seller</a>
        <BowlArt />
      </section>
    </div>
  )
}

// "Cakes and bakes" -> "Cakes", so labels fit under the round icons.
const shortName = (name: string) => name.split(' and ')[0]

function CatTile({ slug, name, to }: { slug: string; name: string; to: string }) {
  return (
    <a className="cat-tile" href={to} onClick={link(to)} role="listitem">
      <span className="cat-ic"><CategoryIcon slug={slug} /></span>
      <span>{name}</span>
    </a>
  )
}
