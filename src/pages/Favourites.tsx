import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link, queryParam } from '../lib/router'
import { dishQuery, loadRatings, type Dish, type Rating } from '../lib/catalogue'
import { DishCard, SellerRow, useFavourites, type ShopCardData } from '../lib/ui'

// Saved dishes and favourite cooks.
export default function Favourites() {
  const { favs } = useFavourites()
  const [tab, setTab] = useState<'dishes' | 'sellers'>(queryParam('tab') === 'sellers' ? 'sellers' : 'dishes')
  const [dishes, setDishes] = useState<Dish[] | null>(null)
  const [shops, setShops] = useState<ShopCardData[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const loaded = favs !== null

  // Load once the list of saved ids is known; later un-hearting just hides the card.
  useEffect(() => {
    if (!loaded) return
    const ids = [...favs!]
    const productIds = ids.filter((k) => k.startsWith('p:')).map((k) => k.slice(2))
    const shopIds = ids.filter((k) => k.startsWith('s:')).map((k) => k.slice(2))
    ;(async () => {
      const [d, s] = await Promise.all([
        productIds.length ? dishQuery().in('id', productIds) : Promise.resolve({ data: [] }),
        shopIds.length ? supabase!.from('shops').select('id, name, slug, logo_path, area_label, cuisines').in('id', shopIds) : Promise.resolve({ data: [] }),
      ])
      const list = (d.data ?? []) as unknown as Dish[]
      setDishes(list)
      setShops((s.data ?? []) as ShopCardData[])
      setRatings(await loadRatings([...list.map((x) => x.shop_id), ...shopIds]))
    })()
  }, [loaded])

  const shownDishes = (dishes ?? []).filter((d) => favs?.has(`p:${d.id}`))
  const shownShops = shops.filter((s) => favs?.has(`s:${s.id}`))

  return (
    <div className="stack">
      <h1>Saved</h1>
      <div className="segmented">
        <label className={tab === 'dishes' ? 'on' : ''}>
          <input type="radio" checked={tab === 'dishes'} onChange={() => setTab('dishes')} /> Dishes
        </label>
        <label className={tab === 'sellers' ? 'on' : ''}>
          <input type="radio" checked={tab === 'sellers'} onChange={() => setTab('sellers')} /> Cooks
        </label>
      </div>
      {dishes === null && <p className="muted">Loading…</p>}
      {dishes && tab === 'dishes' && (shownDishes.length ? (
        <div className="grid2">{shownDishes.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} />)}</div>
      ) : <Empty what="dish" />)}
      {dishes && tab === 'sellers' && (shownShops.length ? (
        <div className="stack" style={{ gap: 10 }}>{shownShops.map((s) => <SellerRow key={s.id} shop={s} rating={ratings[s.id]} />)}</div>
      ) : <Empty what="cook" />)}
    </div>
  )
}

function Empty({ what }: { what: string }) {
  return (
    <div className="empty">
      <span className="big">🤍</span>
      <p>Tap the heart on any {what} to save it here.</p>
      <a className="button" href="/explore" onClick={link('/explore')}>Explore food</a>
    </div>
  )
}
