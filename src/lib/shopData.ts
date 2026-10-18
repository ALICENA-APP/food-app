import { supabase } from './supabase'
import type { Review } from './reviews'
import { addDays } from './hours'
import type { Allergen, Presence, Product, ProductAddon, ProductVariant, Shop, ShopSettings } from './types'

export type AllergenRow = { product_id: string; allergen_code: string; presence: Presence }

export type ShopData = {
  shop: Shop
  settings: ShopSettings | null
  products: Product[]
  allergens: Allergen[]
  rows: AllergenRow[]
  images: Record<string, string[]>
  variants: ProductVariant[]
  addons: ProductAddon[]
  hours: { weekday: number; opens: string; closes: string }[]
  closedDates: string[]
  awayReason: string | null
  reviews: Review[]
  categories: { id: string; name: string; slug: string }[]
}

// Everything the shop page and dish pages show. Cached briefly so moving
// between a shop and its dishes doesn't reload it all.
const cache = new Map<string, { at: number; data: ShopData | null }>()

export async function loadShop(slug: string): Promise<ShopData | null> {
  const hit = cache.get(slug)
  if (hit && Date.now() - hit.at < 60000) return hit.data
  const db = supabase!
  const { data: shop } = await db.from('shops').select('*').eq('slug', slug).maybeSingle()
  if (!shop) return null
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
  const [s, p, a, h, c, r, cat] = await Promise.all([
    db.from('shop_settings').select('*').eq('shop_id', shop.id).maybeSingle(),
    db.from('products').select('*').eq('shop_id', shop.id).neq('status', 'archived').order('created_at'),
    db.from('allergens').select('code, name'),
    db.from('shop_hours').select('weekday, opens, closes').eq('shop_id', shop.id),
    db.from('shop_closures').select('closed_on, reason').eq('shop_id', shop.id).gte('closed_on', today).lte('closed_on', addDays(today, 60)).order('closed_on'),
    db.from('reviews').select('*').eq('shop_id', shop.id).eq('hidden', false).order('created_at', { ascending: false }).limit(50),
    db.from('categories').select('id, name, slug').order('sort'),
  ])
  const products: Product[] = p.data ?? []
  const ids = products.map((x) => x.id)
  const [rows, imgs, vars, adds] = ids.length
    ? await Promise.all([
        db.from('product_allergens').select('product_id, allergen_code, presence').in('product_id', ids).is('variant_id', null).is('addon_id', null),
        db.from('product_images').select('product_id, path, sort').in('product_id', ids).order('sort'),
        db.from('product_variants').select('*').in('product_id', ids).order('sort').order('price_delta_pence'),
        db.from('product_addons').select('*').in('product_id', ids).order('sort').order('name'),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }, { data: [] }]
  const images: Record<string, string[]> = {}
  for (const img of imgs.data ?? []) (images[img.product_id] ??= []).push(img.path)
  const data: ShopData = {
    shop, settings: s.data, products, allergens: a.data ?? [], rows: rows.data ?? [], images,
    variants: (vars.data ?? []) as ProductVariant[], addons: (adds.data ?? []) as ProductAddon[],
    hours: h.data ?? [], closedDates: (c.data ?? []).map((x) => x.closed_on), awayReason: c.data?.[0]?.closed_on === today ? c.data[0].reason : null, reviews: r.data ?? [], categories: cat.data ?? [],
  }
  cache.set(slug, { at: Date.now(), data })
  return data
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Groups days with the same hours: "Mon–Fri 10:00–18:00 · Sat 11:00–15:00".
export function hoursSummary(hours: ShopData['hours']) {
  const sorted = [...hours].sort((a, b) => a.weekday - b.weekday)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    const t = `${sorted[i].opens.slice(0, 5)}–${sorted[i].closes.slice(0, 5)}`
    while (j + 1 < sorted.length && sorted[j + 1].weekday === sorted[j].weekday + 1 &&
           `${sorted[j + 1].opens.slice(0, 5)}–${sorted[j + 1].closes.slice(0, 5)}` === t) j++
    const days = i === j ? DAY_SHORT[sorted[i].weekday] : `${DAY_SHORT[sorted[i].weekday]}–${DAY_SHORT[sorted[j].weekday]}`
    parts.push(`${days} ${t}`)
    i = j + 1
  }
  return parts.join(' · ')
}

export function allergenLists(data: ShopData, productId: string) {
  const name = (code: string) => data.allergens.find((a) => a.code === code)?.name ?? code
  const mine = data.rows.filter((r) => r.product_id === productId)
  return {
    contains: mine.filter((r) => r.presence === 'contains').map((r) => name(r.allergen_code)),
    mayContain: mine.filter((r) => r.presence === 'may_contain').map((r) => name(r.allergen_code)),
  }
}

export function averageRating(reviews: Review[]) {
  return reviews.length ? reviews.reduce((n, r) => n + r.rating, 0) / reviews.length : 0
}

// Whether a dish has sizes or extras to choose before adding it.
export const hasOptions = (data: ShopData, productId: string) =>
  data.variants.some((v) => v.product_id === productId) || data.addons.some((a) => a.product_id === productId)
