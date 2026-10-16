import { supabase } from './supabase'

// Counts a visit to a shop page, a dish page or a click on a featured spot,
// once per browser session each, so cooks can see how many people look.
export function recordView(shopId: string, kind: 'shop' | 'dish' | 'featured', itemId = shopId) {
  const key = `viewed:${kind}:${itemId}`
  try {
    if (sessionStorage.getItem(key)) return
    sessionStorage.setItem(key, '1')
  } catch {
    // storage unavailable: count anyway
  }
  supabase?.rpc('record_view', { p_shop: shopId, p_kind: kind }).then(() => undefined, () => undefined)
}

export type RecentDish = { id: string; slug: string; name: string; shopName: string; pricePence: number; photo: string | null }
const RECENT = 'recentDishes'

// Dishes this browser opened lately, newest first (kept on this device only).
export function readRecent(): RecentDish[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as RecentDish[]
  } catch {
    return []
  }
}

export function rememberDish(d: RecentDish) {
  try {
    localStorage.setItem(RECENT, JSON.stringify([d, ...readRecent().filter((x) => x.id !== d.id)].slice(0, 10)))
  } catch {
    // storage unavailable
  }
}
