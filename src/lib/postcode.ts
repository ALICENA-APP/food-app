import { useEffect, useState } from 'react'
import { supabase } from './supabase'

const KEY = 'myPostcode'
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

export function readPostcode() {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

// The customer's postcode, remembered on this device, used to show who delivers to them.
export function usePostcode(): [string, (p: string) => void] {
  const [value, setValue] = useState(readPostcode)
  useEffect(() => {
    const update = () => setValue(readPostcode())
    window.addEventListener(EVENT, update)
    return () => window.removeEventListener(EVENT, update)
  }, [])
  const set = (p: string) => {
    try {
      if (p) localStorage.setItem(KEY, formatPostcode(p))
      else localStorage.removeItem(KEY)
    } catch {
      // storage unavailable
    }
    window.dispatchEvent(new Event(EVENT))
  }
  return [value, set]
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
