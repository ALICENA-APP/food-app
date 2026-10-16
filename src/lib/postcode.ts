import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const KEY = 'myPostcode'
const POINT_KEY = 'myPoint'
const EVENT = 'postcode-changed'

// UK postcode with the space in the right place: "e32aa" -> "E3 2AA".
export function formatPostcode(p: string) {
  const t = p.toUpperCase().replace(/\s+/g, '')
  return t.length >= 5 ? `${t.slice(0, -3)} ${t.slice(-3)}` : t
}

export function postcodeDistrict(p: string) {
  return formatPostcode(p).split(' ')[0]
}

export const looksLikePostcode = (p: string) => /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i.test(p.trim()) || /^[A-Z]{1,2}\d[A-Z\d]?$/i.test(p.trim())

export type Point = { lat: number; lng: number }

export function readPoint(): Point | null {
  try {
    return JSON.parse(localStorage.getItem(POINT_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function readPostcode() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

// The customer's postcode and its location, remembered on this device, used
// to show nearby cooks and who delivers to them.
export function usePostcode(): [string, (p: string, point: Point | null) => void, Point | null] {
  const [value, setValue] = useState(readPostcode)
  const [point, setPoint] = useState(readPoint)
  useEffect(() => {
    const update = () => {
      setValue(readPostcode())
      setPoint(readPoint())
    }
    window.addEventListener(EVENT, update)
    return () => window.removeEventListener(EVENT, update)
  }, [])
  const set = (p: string, at: Point | null) => {
    try {
      if (p) localStorage.setItem(KEY, formatPostcode(p))
      else localStorage.removeItem(KEY)
      if (p && at) localStorage.setItem(POINT_KEY, JSON.stringify(at))
      else localStorage.removeItem(POINT_KEY)
    } catch {
      // storage unavailable
    }
    window.dispatchEvent(new Event(EVENT))
  }
  return [value, set, point]
}

export type Near = { miles: number; delivers: boolean; fee: number }

// Live shops within `miles` of a point, with rounded distance and whether
// they deliver there by distance.
export async function loadNear(point: Point | null, miles = 20): Promise<Record<string, Near>> {
  if (!point || !supabase) return {}
  const { data } = await supabase.rpc('shops_near', { p_lat: point.lat, p_lng: point.lng, p_miles: miles })
  return Object.fromEntries(((data ?? []) as { shop_id: string; miles: number; delivers: boolean; fee_pence: number }[])
    .map((r) => [r.shop_id, { miles: r.miles, delivers: r.delivers, fee: r.fee_pence }]))
}

// For each shop, whether it delivers to the given district and the cheapest fee.
export async function loadDeliveryTo(shopIds: string[], district: string) {
  const ids = [...new Set(shopIds)]
  if (!ids.length || !district) return {} as Record<string, number>
  const { data } = await supabase!.from('shop_delivery_zones').select('shop_id, postcode_districts, fee_pence').in('shop_id', ids)
  const fees: Record<string, number> = {}
  for (const z of data ?? []) {
    if (z.postcode_districts.includes(district) && (fees[z.shop_id] === undefined || z.fee_pence < fees[z.shop_id])) fees[z.shop_id] = z.fee_pence
  }
  return fees
}
