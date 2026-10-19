import type { PlatformSettings } from './platform'

// The customer's service fee for an order worth `base` (food after discount +
// delivery). It covers the card payment cost (Stripe's 1.5% + 20p, on the
// whole payment), the same however they pay. Matches food.service_fee().
export function serviceFee(base: number, s: Pick<PlatformSettings, 'service_fee_bps' | 'service_fee_fixed_pence'>) {
  if (base <= 0) return 0
  const r = s.service_fee_bps / 10000
  return Math.round((base * r + s.service_fee_fixed_pence) / (1 - r))
}

// What reaches the cook from one order: everything except BiteBY's fee and
// the customer's service fee.
export function cookGets(o: { total_pence: number; platform_fee_pence: number; service_fee_pence?: number | null }) {
  return o.total_pence - o.platform_fee_pence - (o.service_fee_pence ?? 0)
}
