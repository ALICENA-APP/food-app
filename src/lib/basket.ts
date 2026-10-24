import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// One shop per basket. Kept in this browser, plus a copy in the database for
// signed-in customers so we can send one gentle reminder. Prices are always
// worked out again by the database when the order is placed.
export type BasketLine = {
  productId: string
  name: string
  pricePence: number // one portion, with any size and extras
  qty: number
  photo?: string | null
  variantId?: string | null
  addonIds?: string[]
  options?: string // "Large, + Plantain", shown under the name
}
export type Basket = { shopId: string; shopSlug: string; shopName: string; lines: BasketLine[] }

const KEY = 'basket'
const EVENT = 'basket-changed'

export function readBasket(): Basket | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Basket) : null
  } catch {
    return null
  }
}

export function writeBasket(b: Basket | null) {
  try {
    if (b && b.lines.length) localStorage.setItem(KEY, JSON.stringify(b))
    else localStorage.removeItem(KEY)
  } catch {
    // storage unavailable: basket lasts until the page reloads
    memory = b
  }
  window.dispatchEvent(new Event(EVENT))
  queueSave(b && b.lines.length ? b : null)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function queueSave(b: Basket | null) {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    const { data } = (await supabase?.auth.getSession()) ?? { data: null }
    if (!data?.session) return
    supabase!.rpc('save_basket', { p_shop: b?.shopId ?? null, p_lines: b ? b.lines : [] }).then(() => {}, () => {})
  }, 1500)
}

// Brings back a basket saved on another device (or after a reminder).
// A basket made before signing in is saved now.
export async function restoreBasket() {
  if (!supabase) return
  const local = readBasket()
  if (local) return queueSave(local)
  const { data: auth } = await supabase.auth.getSession()
  if (!auth.session) return
  const { data } = await supabase.from('saved_baskets').select('shop_id, lines, shops(slug, name)').maybeSingle()
  const shop = data?.shops as unknown as { slug: string; name: string } | null
  if (!data || !shop || readBasket()) return
  localStorage.setItem(KEY, JSON.stringify({ shopId: data.shop_id, shopSlug: shop.slug, shopName: shop.name, lines: data.lines }))
  window.dispatchEvent(new Event(EVENT))
}

let memory: Basket | null = null

export function useBasket() {
  const [basket, setBasket] = useState<Basket | null>(() => readBasket() ?? memory)
  useEffect(() => {
    const update = () => setBasket(readBasket() ?? memory)
    window.addEventListener(EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  return basket
}

export function basketCount(b: Basket | null) {
  return b ? b.lines.reduce((n, l) => n + l.qty, 0) : 0
}

export function basketSubtotal(b: Basket | null) {
  return b ? b.lines.reduce((n, l) => n + l.qty * l.pricePence, 0) : 0
}

// The same dish with different choices is a separate line.
export const lineKey = (l: Pick<BasketLine, 'productId' | 'variantId' | 'addonIds'>) =>
  [l.productId, l.variantId ?? '', ...[...(l.addonIds ?? [])].sort()].join('|')

// How many of a dish are in the basket, across all its choices.
export function qtyIn(b: Basket | null, shopId: string, productId: string) {
  return b?.shopId === shopId ? b.lines.filter((l) => l.productId === productId).reduce((n, l) => n + l.qty, 0) : 0
}

// How many of this exact dish and choices are in the basket.
export function lineQty(b: Basket | null, shopId: string, item: Pick<BasketLine, 'productId' | 'variantId' | 'addonIds'>) {
  return b?.shopId === shopId ? b.lines.find((l) => lineKey(l) === lineKey(item))?.qty ?? 0 : 0
}

export function setQty(
  shop: { id: string; slug: string; name: string },
  item: Omit<BasketLine, 'qty'>,
  qty: number,
): boolean {
  let b = readBasket() ?? memory
  if (b && b.shopId !== shop.id) {
    if (!window.confirm(`Your basket has food from ${b.shopName}. Start a new basket for ${shop.name}?`)) return false
    b = null
  }
  b = b ?? { shopId: shop.id, shopSlug: shop.slug, shopName: shop.name, lines: [] }
  const line = { ...item, qty: Math.min(qty, 50) }
  const key = lineKey(item)
  const lines = b.lines.some((l) => lineKey(l) === key)
    ? b.lines.map((l) => (lineKey(l) === key ? line : l)).filter((l) => l.qty > 0)
    : qty > 0 ? [...b.lines, line] : b.lines
  writeBasket({ ...b, lines })
  return true
}
