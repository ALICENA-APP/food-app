import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { dishQuery, loadRatings, type Dish, type Rating } from '../lib/catalogue'
import { loadOpenStates, type OpenState } from '../lib/hours'
import { DishCard, SellerRow, type ShopCardData } from '../lib/ui'

export type Town = { slug: string; town: string; shops: number; real_shops: number }

export function useTowns() {
  const [towns, setTowns] = useState<Town[]>([])
  useEffect(() => {
    supabase?.rpc('towns').then(({ data }) => setTowns((data ?? []) as Town[]), () => {})
  }, [])
  return towns
}

// Links to every town page, at the bottom of the home page (also how Google
// finds them).
export function TownLinks({ towns, current }: { towns: Town[]; current?: string }) {
  const shown = towns.filter((t) => t.slug !== current)
  if (!shown.length) return null
  return (
    <section className="stack">
      <h2>{current ? 'Other areas' : 'Homemade food near you'}</h2>
      <div className="chips wrap">
        {shown.map((t) => (
          <a key={t.slug} className="chip" href={`/near/${t.slug}`} onClick={link(`/near/${t.slug}`)}>{t.town}</a>
        ))}
      </div>
    </section>
  )
}

// "Homemade food in Bow": the cooks in one town and their dishes.
export default function TownPage({ slug }: { slug: string }) {
  const towns = useTowns()
  const [shops, setShops] = useState<ShopCardData[] | null>(null)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [open, setOpen] = useState<Record<string, OpenState>>({})
  const town = towns.find((t) => t.slug === slug)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: ids } = await db.rpc('town_shop_ids', { p_slug: slug })
      const list = ((ids ?? []) as string[])
      if (!list.length) return setShops([])
      const [s, d, r, o] = await Promise.all([
        db.from('shops').select('id, name, slug, logo_path, area_label, cuisines, is_demo').in('id', list),
        dishQuery().in('shop_id', list).order('created_at', { ascending: false }).limit(12),
        loadRatings(list),
        loadOpenStates(list),
      ])
      setShops(s.data ?? [])
      setDishes((d.data ?? []) as unknown as Dish[])
      setRatings(r)
      setOpen(o)
    })()
  }, [slug])

  useEffect(() => {
    if (!town) return
    document.title = `Homemade food in ${town.town} · BiteBY`
    return () => { document.title = 'BiteBY · Real food. Real people.' }
  }, [town])

  if (!shops) return <p className="muted">Loading…</p>
  const name = town?.town ?? slug.replace(/-/g, ' ')
  return (
    <div className="stack">
      <div>
        <h1>Homemade food in {name}</h1>
        <p className="muted">
          {shops.length ? `${shops.length === 1 ? '1 local cook' : `${shops.length} local cooks`} cooking real food at home, for collection or delivery.` : `No cooks in ${name} yet.`}
        </p>
      </div>
      {shops.length === 0 && (
        <div className="card">
          <p>Cook at home in {name}? Be the first on BiteBY.</p>
          <a className="button" href="/sell" onClick={link('/sell')}>Become a seller</a>
        </div>
      )}
      {shops.length > 0 && (
        <section className="stack">
          <h2>Cooks</h2>
          <div className="stack" style={{ gap: 10 }}>
            {shops.map((s) => <SellerRow key={s.id} shop={s} rating={ratings[s.id]} open={open[s.id]} />)}
          </div>
        </section>
      )}
      {dishes.length > 0 && (
        <section className="stack">
          <h2>On the menu</h2>
          <div className="grid2">
            {dishes.map((d) => <DishCard key={d.id} dish={d} rating={ratings[d.shop_id]} />)}
          </div>
        </section>
      )}
      <TownLinks towns={towns} current={slug} />
    </div>
  )
}
