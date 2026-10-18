import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export type PlatformSettings = { commission_bps: number; promo_week_pence: number; promo_slots: number; promo_radius_miles: number }

const DEFAULTS: PlatformSettings = { commission_bps: 1000, promo_week_pence: 500, promo_slots: 8, promo_radius_miles: 10 }
let cached: Promise<PlatformSettings> | null = null

// BiteBY's commission and featured-spot price, as set in Admin > Settings.
export function loadPlatform(fresh = false): Promise<PlatformSettings> {
  if (!cached || fresh) {
    cached = Promise.resolve(supabase!.from('platform_settings').select('commission_bps, promo_week_pence, promo_slots, promo_radius_miles').maybeSingle())
      .then(({ data }) => ({ ...DEFAULTS, ...(data ?? {}) }))
      .catch(() => DEFAULTS)
  }
  return cached
}

export function usePlatform(): PlatformSettings {
  const [s, setS] = useState(DEFAULTS)
  useEffect(() => {
    loadPlatform().then(setS)
  }, [])
  return s
}

// "10%" or "12.5%".
export const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`

// The commission as words for help text.
export function useCommission() {
  return percent(usePlatform().commission_bps)
}
