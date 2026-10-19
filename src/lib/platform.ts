import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export type PlatformSettings = { commission_bps: number; promo_week_pence: number; promo_slots: number; promo_radius_miles: number; intro_commission_bps: number; intro_days: number; service_fee_bps: number; service_fee_fixed_pence: number; invite_free_days: number; invite_orders_needed: number; invite_max_rewards: number; intro_spots: number | null; spots_taken: number }

const DEFAULTS: PlatformSettings = { commission_bps: 1000, promo_week_pence: 500, promo_slots: 8, promo_radius_miles: 10, intro_commission_bps: 0, intro_days: 30, service_fee_bps: 150, service_fee_fixed_pence: 20, invite_free_days: 30, invite_orders_needed: 5, invite_max_rewards: 3, intro_spots: null, spots_taken: 0 }
let cached: Promise<PlatformSettings> | null = null

// BiteBY's commission and featured-spot price, as set in Admin > Settings.
export function loadPlatform(fresh = false): Promise<PlatformSettings> {
  if (!cached || fresh) {
    cached = Promise.all([
      supabase!.from('platform_settings').select('commission_bps, promo_week_pence, promo_slots, promo_radius_miles, intro_commission_bps, intro_days, service_fee_bps, service_fee_fixed_pence, invite_free_days, invite_orders_needed, invite_max_rewards, intro_spots').maybeSingle(),
      supabase!.rpc('founding_spots'),
    ])
      .then(([{ data }, spots]) => ({ ...DEFAULTS, ...(data ?? {}), spots_taken: (spots.data as { taken?: number } | null)?.taken ?? 0 }))
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

// Whether new cooks can still get the welcome offer (it's for the first
// intro_spots cooks, or everyone when that's blank).
function introOpen(s: PlatformSettings) {
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  return Boolean(s.intro_days) && intro < s.commission_bps && (s.intro_spots === null || s.spots_taken < s.intro_spots)
}
const firstCooks = (s: PlatformSettings) => (s.intro_spots === null ? '' : `our first ${s.intro_spots} cooks`)

// Founding spots taken and in total, or null when the offer is for everyone.
export function useFoundingSpots() {
  const s = usePlatform()
  if (s.intro_spots === null || !introOpen(s)) return null
  return { taken: Math.min(s.spots_taken, s.intro_spots), total: s.intro_spots }
}

// The welcome offer for new cooks in words, e.g. "only 5% for your first 30 days",
// or '' when there isn't one.
export function useWelcomeOffer() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  if (!introOpen(s)) return ''
  const who = s.intro_spots === null ? '' : `, for ${firstCooks(s)}`
  return (intro === 0 ? `nothing at all for your first ${s.intro_days} days of selling` : `only ${percent(intro)} for your first ${s.intro_days} days of selling`) + who
}

// A short headline for inviting cooks: "First month free", "5% fee for your
// first month", or '' when there's no welcome offer.
export function useWelcomeHeadline() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  if (!introOpen(s)) return ''
  const span = s.intro_days === 30 ? 'month' : `${s.intro_days} days`
  const who = s.intro_spots === null ? '' : ` for ${firstCooks(s)}`
  return (intro === 0 ? `First ${span} free` : `${percent(intro)} fee for your first ${span}`) + who
}

// One sentence for under the headline.
export function useWelcomeDetail() {
  const s = usePlatform()
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  const normal = percent(s.commission_bps)
  if (!introOpen(s)) return `No sign-up or monthly fee: BiteBY keeps ${normal} of the food price only when you sell.`
  const who = s.intro_spots === null ? 'You' : `Be one of ${firstCooks(s)} and`
  return intro === 0
    ? `${who} keep every penny for your first ${s.intro_days} days, starting when your shop goes live. Then BiteBY keeps just ${normal}, only when you sell. No sign-up or monthly fee.`
    : `${who} pay only ${percent(intro)} for your first ${s.intro_days} days, starting when your shop goes live, then ${normal}, only when you sell. No sign-up or monthly fee.`
}
