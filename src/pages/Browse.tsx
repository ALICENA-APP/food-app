import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { photoUrl } from '../lib/images'
import { Stars } from '../lib/reviews'
import type { Shop } from '../lib/types'

// Home page: live shops, with a simple search.
export default function Browse() {
  const [shops, setShops] = useState<Shop[] | null>(null)
  const [query, setQuery] = useState('')
  const [ratings, setRatings] = useState<Record<string, { average: number; reviews: number }>>({})

  useEffect(() => {
    supabase!
      .from('shops')
      .select('*')
      .eq('status', 'live')
      .order('accepting_orders', { ascending: false })
      .order('name')
      .limit(200)
      .then(async ({ data }) => {
        setShops(data ?? [])
        if (!data?.length) return
        const { data: r } = await supabase!.rpc('shop_ratings', { p_shops: data.map((s) => s.id) })
        setRatings(Object.fromEntries(((r ?? []) as { shop_id: string; average: number; reviews: number }[]).map((x) => [x.shop_id, x])))
      })
  }, [])

  const q = query.trim().toLowerCase()
  const shown = (shops ?? []).filter(
    (s) => !q || [s.name, s.area_label ?? '', ...s.cuisines].some((t) => t.toLowerCase().includes(q)),
  )

  return (
    <div className="stack">
      <p className="lead">Homemade food from cooks near you in East London.</p>
      {shops && shops.length > 0 && (
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by food, cuisine or area" />
      )}
      {shops === null && <p className="muted">Loading…</p>}
      {shops?.length === 0 && (
        <p className="card muted">The first shops are getting ready. Check back soon.</p>
      )}
      {shown.map((s) => (
        <a key={s.id} className="card shop-card" href={`/s/${s.slug}`} onClick={link(`/s/${s.slug}`)}>
          {s.cover_path && <img className="dish" src={photoUrl(s.cover_path)!} alt="" loading="lazy" />}
          <strong>{s.name}</strong>
          <span className="muted small">{[s.area_label, ...s.cuisines].filter(Boolean).join(' · ')}</span>
          {ratings[s.id] && (
            <span className="small"><Stars value={ratings[s.id].average} size="small" /> {Number(ratings[s.id].average).toFixed(1)} ({ratings[s.id].reviews})</span>
          )}
          {!s.accepting_orders && <span className="pill">Not taking orders right now</span>}
        </a>
      ))}
      {shops && shops.length > 0 && q && shown.length === 0 && <p className="muted">No shops match.</p>}

      <div className="card">
        <h2>Cook at home?</h2>
        <p className="muted">
          Open your own little online food shop with a link you can share. No monthly fee, we take
          5% of the food price only when you sell.
        </p>
        <a className="button" href="/sell" onClick={link('/sell')}>Start selling</a>
      </div>
    </div>
  )
}
