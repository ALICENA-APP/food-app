import { useEffect, useState } from 'react'

// One shop per basket. Kept in this browser only; prices are always worked
// out again by the database when the order is placed.
export type BasketLine = { productId: string; name: string; pricePence: number; qty: number }
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

export function setQty(
  shop: { id: string; slug: string; name: string },
  item: { productId: string; name: string; pricePence: number },
  qty: number,
): boolean {
  let b = readBasket() ?? memory
  if (b && b.shopId !== shop.id) {
    if (!window.confirm(`Your basket has food from ${b.shopName}. Start a new basket for ${shop.name}?`)) return false
    b = null
  }
  b = b ?? { shopId: shop.id, shopSlug: shop.slug, shopName: shop.name, lines: [] }
  const line = { ...item, qty: Math.min(qty, 50) }
  const lines = b.lines.some((l) => l.productId === item.productId)
    ? b.lines.map((l) => (l.productId === item.productId ? line : l)).filter((l) => l.qty > 0)
    : qty > 0 ? [...b.lines, line] : b.lines
  writeBasket({ ...b, lines })
  return true
}
