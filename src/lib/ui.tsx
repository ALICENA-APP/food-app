import { useEffect, useState, type MouseEvent } from 'react'
import { supabase } from './supabase'
import { link } from './router'
import { askToSignIn, useSession } from './session'
import { photoUrl } from './images'
import { Icon } from './icons'
import { firstPhoto, type Dish, type Rating } from './catalogue'
import { pounds } from './types'
import type { OpenState } from './hours'

// "Bite" in black, "BY" in yellow, with three small rays.
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <a className="wordmark" href="/" onClick={link('/')} style={{ fontSize: size }} aria-label="BiteBY home">
      Bite<span className="by">BY</span>
      <svg className="rays" viewBox="0 0 22 14" aria-hidden="true">
        <g stroke="#FFC72C" strokeWidth="2.6" strokeLinecap="round">
          <path d="M5 12 3 6" /><path d="M11 11V3" /><path d="M17 12l3-5" />
        </g>
      </svg>
    </a>
  )
}

// Simple drawing of a steaming bowl for banners (no stock photos needed).
export function BowlArt({ className = 'art' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 220 180" aria-hidden="true">
      <g fill="none" stroke="#111" strokeWidth="5" strokeLinecap="round">
        <path d="M80 40c-10-12 10-18 0-32M110 36c-10-12 10-18 0-32M140 40c-10-12 10-18 0-32" opacity=".55" />
      </g>
      <ellipse cx="110" cy="74" rx="92" ry="16" fill="#fff" stroke="#111" strokeWidth="5" />
      <circle cx="78" cy="66" r="10" fill="#22A55B" />
      <circle cx="104" cy="62" r="12" fill="#D64545" />
      <circle cx="132" cy="66" r="10" fill="#FFC72C" stroke="#111" strokeWidth="3" />
      <circle cx="152" cy="70" r="7" fill="#22A55B" />
      <path d="M18 76c4 50 40 82 92 82s88-32 92-82" fill="#111" />
      <path d="M60 116c14 14 30 20 50 20" stroke="#FFC72C" strokeWidth="6" fill="none" strokeLinecap="round" />
      <rect x="70" y="156" width="80" height="12" rx="6" fill="#111" />
    </svg>
  )
}

export function Avatar({ name, path, size }: { name: string; path?: string | null; size?: number }) {
  const url = photoUrl(path)
  return (
    <span className="avatar" style={size ? { width: size, height: size, fontSize: size * 0.4 } : undefined}>
      {url ? <img src={url} alt="" loading="lazy" /> : (name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

export function RatingBadge({ rating }: { rating?: Rating }) {
  if (!rating) return <span className="rating"><span className="tag">New</span></span>
  return (
    <span className="rating">
      <span className="star">★</span> {rating.average.toFixed(1)} <span className="count">({rating.reviews})</span>
    </span>
  )
}

// Saved dishes and sellers for the signed-in person, shared across screens.
type FavKey = `p:${string}` | `s:${string}`
let favs: Set<FavKey> | null = null
let favsFor: string | undefined
const favListeners = new Set<() => void>()

async function loadFavs(userId: string) {
  favsFor = userId
  const { data } = await supabase!.from('favourites').select('product_id, shop_id')
  if (favsFor !== userId) return
  favs = new Set((data ?? []).map((f) => (f.product_id ? `p:${f.product_id}` : `s:${f.shop_id}`) as FavKey))
  favListeners.forEach((f) => f())
}

export function useFavourites() {
  const { session } = useSession()
  const userId = session?.user.id
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    favListeners.add(f)
    if (userId && favsFor !== userId) loadFavs(userId)
    if (!userId) favs = null
    return () => {
      favListeners.delete(f)
    }
  }, [userId])
  return { favs: userId ? favs : null, signedIn: Boolean(userId) }
}

export function HeartButton({ productId, shopId, className = 'heart' }: { productId?: string; shopId?: string; className?: string }) {
  const { favs, signedIn } = useFavourites()
  const key = (productId ? `p:${productId}` : `s:${shopId}`) as FavKey
  const on = Boolean(favs?.has(key))

  async function toggle(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (!signedIn) return askToSignIn()
    if (!favs) return
    const db = supabase!
    const column = productId ? 'product_id' : 'shop_id'
    const id = productId ?? shopId!
    if (on) favs.delete(key)
    else favs.add(key)
    favListeners.forEach((f) => f())
    const { error } = on
      ? await db.from('favourites').delete().eq(column, id)
      : await db.from('favourites').insert(productId ? { product_id: id } : { shop_id: id })
    if (error) {
      if (on) favs.add(key)
      else favs.delete(key)
      favListeners.forEach((f) => f())
    }
  }

  return (
    <button type="button" className={`${className} ${on ? 'on' : ''}`} onClick={toggle} aria-pressed={on}
      aria-label={on ? 'Remove from saved' : 'Save'}>
      <Icon name="heart" filled={on} />
    </button>
  )
}

export function FoodPhoto({ path, alt }: { path: string | null; alt: string }) {
  const url = photoUrl(path)
  return url ? <img src={url} alt={alt} loading="lazy" /> : <span className="placeholder-food" aria-hidden="true">🍲</span>
}

export function dishLink(d: Pick<Dish, 'id' | 'shops'>) {
  return `/s/${d.shops.slug}/i/${d.id}`
}

export function DishCard({ dish, rating }: { dish: Dish; rating?: Rating }) {
  const to = dishLink(dish)
  return (
    <a className={`dish-card ${dish.stock_qty === 0 ? 'sold-out' : ''}`} href={to} onClick={link(to)}>
      <span className="ph"><FoodPhoto path={firstPhoto(dish)} alt={dish.name} /></span>
      <HeartButton productId={dish.id} />
      <span className="body">
        <span className="name">{dish.name}</span>
        <span className="by">{dish.shops.name}</span>
        <span className="foot">
          <span className="price">{pounds(dish.price_pence)}</span>
          {dish.stock_qty === 0 ? <span className="tag red">Sold out</span> : <RatingBadge rating={rating} />}
        </span>
      </span>
    </a>
  )
}

export type ShopCardData = { id: string; name: string; slug: string; logo_path: string | null; area_label: string | null; cuisines: string[] }

// Distances come rounded to whole miles from the database.
export function distanceLabel(miles?: number) {
  if (!miles) return ''
  return miles <= 1 ? 'Under 1 mi' : `About ${miles} mi`
}

function OpenLabel({ state }: { state?: OpenState }) {
  if (!state) return null
  return <span className={`open-label ${state.open ? 'on' : ''}`}>{state.open ? 'Open now' : state.label}</span>
}

export function SellerCard({ shop, rating, open, miles }: { shop: ShopCardData; rating?: Rating; open?: OpenState; miles?: number }) {
  const to = `/s/${shop.slug}`
  return (
    <a className="seller-card" href={to} onClick={link(to)}>
      <HeartButton shopId={shop.id} />
      <Avatar name={shop.name} path={shop.logo_path} />
      <strong>{shop.name}</strong>
      <RatingBadge rating={rating} />
      {(shop.area_label || miles) && <span className="muted tiny">{[shop.area_label, distanceLabel(miles)].filter(Boolean).join(' · ')}</span>}
      <OpenLabel state={open} />
      {shop.cuisines.length > 0 && <span className="tags">{shop.cuisines.slice(0, 2).map((c) => <span key={c} className="tag">{c}</span>)}</span>}
    </a>
  )
}

export function SellerRow({ shop, rating, open, miles }: { shop: ShopCardData; rating?: Rating; open?: OpenState; miles?: number }) {
  const to = `/s/${shop.slug}`
  return (
    <a className="seller-row card" href={to} onClick={link(to)} style={{ flexDirection: 'row' }}>
      <Avatar name={shop.name} path={shop.logo_path} />
      <span className="stack" style={{ gap: 3, flex: 1, minWidth: 0 }}>
        <strong>{shop.name}</strong>
        <span className="muted tiny">{[distanceLabel(miles), shop.area_label, ...shop.cuisines].filter(Boolean).join(' · ')}</span>
        <span className="row wrap" style={{ gap: 8, alignItems: 'center' }}><RatingBadge rating={rating} /><OpenLabel state={open} /></span>
      </span>
      <HeartButton shopId={shop.id} className="heart inline" />
    </a>
  )
}

export function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="icon-btn" onClick={onClick} aria-label="Back">
      <Icon name="back" />
    </button>
  )
}

export async function share(title: string, url = window.location.href) {
  try {
    if (navigator.share) return await navigator.share({ title, url })
    await navigator.clipboard.writeText(url)
    window.alert('Link copied')
  } catch {
    // cancelled
  }
}
