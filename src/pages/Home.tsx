import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { Icon } from '../lib/icons'
import { dishQuery, loadRatings, useCategories, type Dish, type Rating } from '../lib/catalogue'
import { loadOpenStates, type OpenState } from '../lib/hours'
import { InstallPrompt } from '../lib/install'
import { BowlArt, DishCard, SellerCard, type ShopCardData } from '../lib/ui'

// The first screen everyone sees, signed in or not.
export default function Home() {
  const categories = useCategories()
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [shops, setShops] = useState<ShopCardData[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, OpenState>>({})

  useEffect(() => {
    ;(async () => {
      const [d, s] = await Promise.all([
        dishQuery().order('created_at', { ascending: false }).limit(60),
        supabase!.from('shops').select('id, name, slug, logo_path, area_label, cuisines').eq('status', 'live').limit(60),
      ])
      const list = (d.data ?? []) as unknown as Dish[]
      setDishes(list)
      setShops(s.data ?? [])
      const ids = (s.data ?? []).map((x) => x.id)
      const [r, o] = await Promise.all([loadRatings(ids), loadOpenStates(ids)])
      setRatings(r)
      setOpen(o)
    })()
  }, [])

  function search(e: FormEvent) {
    e.preventDefault()
    navigate(`/explore${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`)
  }

  const desserts = categories.filter((c) => ['desserts', 'cakes-bakes'].includes(c.slug)).map((c) => c.id)
  const rated = (shopId: string) => ratings[shopId]?.average ?? 0
  const popular = [...(dishes ?? [])].sort((a, b) => rated(b.shop_id) - rated(a.shop_id)).slice(0, 10)
  const sweet = (dishes ?? []).filter((d) => d.category_id && desserts.includes(d.category_id)).slice(0, 10)
  const topShops = [...shops].sort((a, b) => rated(b.id) - rated(a.id) || (ratings[b.id]?.reviews ?? 0) - (ratings[a.id]?.reviews ?? 0)).slice(0, 10)

  return (
    <div className="stack-lg">
      <div className="stack">
        <p className="location"><Icon name="pin" size={18} /> East London</p>
        <form className="search" onSubmit={search} role="search">
          <Icon name="search" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search dishes, cooks or cuisines" aria-label="Search" />
        </form>
        <div className="chips">
          <a className="chip on" href="/explore" onClick={link('/explore')}>All</a>
          {categories.map((c) => (
            <a key={c.id} className="chip" href={`/explore?c=${c.slug}`} onClick={link(`/explore?c=${c.slug}`)}>{c.name}</a>
          ))}
          <a className="chip" href="/explore?diet=vegan" onClick={link('/explore?diet=vegan')}>Vegan</a>
        </div>
      </div>

      <InstallPrompt />

      <section className="hero">
        <span className="kicker">Homemade · Local · Fresh</span>
        <h2>Real food. Real people.</h2>
        <p>Order homemade food from cooks in your neighbourhood.</p>
        <a className="button dark" href="/explore?view=sellers" onClick={link('/explore?view=sellers')}>Browse local sellers</a>
        <BowlArt />
      </section>

      {dishes === null && <p className="muted">Loading…</p>}

      {dishes && dishes.length === 0 && (
        <section className="card empty">
          <span className="big">👩🏾‍🍳</span>
          <h2 style={{ color: 'var(--text)' }}>The first cooks are getting ready</h2>
          <p>BiteBY is opening in East London soon. Have a look around, and check back for the first menus.</p>
        </section>
      )}

      {popular.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <h2>Popular near you</h2>
            <a href="/explore" onClick={link('/explore')}>See all</a>
          </div>
          <div className="hscroll">
            {popular.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} />)}
          </div>
        </section>
      )}

      {topShops.length > 0 && (
        <section className="stack">
          <div className="section-head">
            <h2>Top rated sellers</h2>
            <a href="/explore?view=sellers" onClick={link('/explore?view=sellers')}>See all</a>
          </div>
          <div className="hscroll">
            {topShops.map((s) => <SellerCard key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} />)}
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
            {sweet.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} />)}
          </div>
        </section>
      )}

      <section className="promo">
        <h2>Cook at home? Sell on BiteBY</h2>
        <p>Open your own food shop with a link you can share. No monthly fee: we take 5% of the food price only when you sell.</p>
        <a className="button dark" href="/sell" onClick={link('/sell')}>Become a seller</a>
        <BowlArt />
      </section>
    </div>
  )
}
