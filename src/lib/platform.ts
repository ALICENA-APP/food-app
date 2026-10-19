import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export type PlatformSettings = { commission_bps: number; promo_week_pence: number; promo_slots: number; promo_radius_miles: number; intro_commission_bps: number; intro_days: number; service_fee_bps: number; service_fee_fixed_pence: number; invite_free_days: number; invite_orders_needed: number; invite_max_rewards: number }

const DEFAULTS: PlatformSettings = { commission_bps: 1000, promo_week_pence: 500, promo_slots: 8, promo_radius_miles: 10, intro_commission_bps: 0, intro_days: 30, service_fee_bps: 150, service_fee_fixed_pence: 20, invite_free_days: 30, invite_orders_needed: 5, invite_max_rewards: 3 }
let cached: Promise<PlatformSettings> | null = null

// BiteBY's commission and featured-spot price, as set in Admin > Settings.
export function loadPlatform(fresh = false): Promise<PlatformSettings> {
  if (!cached || fresh) {
    cached = Promise.resolve(supabase!.from('platform_settings').select('commission_bps, promo_week_pence, promo_slots, promo_radius_miles, intro_commission_bps, intro_days, service_fee_bps, service_fee_fixed_pence, invite_free_days, invite_orders_needed, invite_max_rewards').maybeSingle())
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

// The welcome offer for new cooks in words, e.g. "only 5% for your first 30 days",
// or '' when there isn't one.
export function useWelcomeOffer() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  if (!s.intro_days || intro >= s.commission_bps) return ''
  return intro === 0 ? `nothing at all for your first ${s.intro_days} days of selling` : `only ${percent(intro)} for your first ${s.intro_days} days of selling`
}

// A short headline for inviting cooks: "First month free", "5% fee for your
// first month", or '' when there's no welcome offer.
export function useWelcomeHeadline() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  if (!s.intro_days || intro >= s.commission_bps) return ''
  const span = s.intro_days === 30 ? 'month' : `${s.intro_days} days`
  return intro === 0 ? `First ${span} free` : `${percent(intro)} fee for your first ${span}`
}

// One sentence for under the headline.
export function useWelcomeDetail() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  const normal = percent(s.commission_bps)
  if (!s.intro_days || intro >= s.commission_bps) return `No sign-up or monthly fee: BiteBY keeps ${normal} of the food price only when you sell.`
  return intro === 0
    ? `Keep every penny for your first ${s.intro_days} days, starting when your shop goes live. Then BiteBY keeps just ${normal}, only when you sell. No sign-up or monthly fee.`
    : `BiteBY keeps only ${percent(intro)} for your first ${s.intro_days} days, starting when your shop goes live, then ${normal}, only when you sell. No sign-up or monthly fee.`
}
