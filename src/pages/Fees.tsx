import { useEffect, useState } from 'react'
import { link } from '../lib/router'
import { pounds } from '../lib/types'
import { percent, usePlatform, useWelcomeHeadline } from '../lib/platform'
import { serviceFee } from '../lib/fees'
import { supabase } from '../lib/supabase'

type MyRate = { rate_bps: number; standard_bps: number; intro_bps: number; intro_days: number; intro_started: boolean; intro_ends_at: string | null }

// The cook's own fee right now, for their screens. Null until loaded or if
// they have no shop.
export function useMyFeeRate(shopId: string | null | undefined) {
  const [rate, setRate] = useState<MyRate | null>(null)
  useEffect(() => {
    if (!shopId || !supabase) return
    supabase.rpc('my_fee_rate', { p_shop: shopId }).then(({ data }) => setRate((data as MyRate) ?? null))
  }, [shopId])
  return rate
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })

// A short line about the cook's welcome rate, for their dashboard.
export function WelcomeRate({ shopId }: { shopId: string }) {
  const r = useMyFeeRate(shopId)
  if (!r || r.intro_bps >= r.standard_bps || !r.intro_days) return null
  const ends = r.intro_ends_at ? new Date(r.intro_ends_at) : null
  if (ends && ends.getTime() < Date.now()) return null
  return (
    <a className="card welcome-rate" href="/fees" onClick={link('/fees')}>
      <strong>Welcome offer: {r.intro_bps === 0 ? 'no BiteBY fee' : `${percent(r.intro_bps)} BiteBY fee`}</strong>
      <span className="muted small">
        {ends
          ? `Until ${day(ends.toISOString())}, BiteBY keeps ${r.intro_bps === 0 ? 'nothing from' : `only ${percent(r.intro_bps)} of`} your food sales instead of ${percent(r.standard_bps)}.`
          : `Your first ${r.intro_days} days of selling start with your first order. During them BiteBY keeps ${r.intro_bps === 0 ? 'nothing' : `only ${percent(r.intro_bps)}`} instead of ${percent(r.standard_bps)}.`}
        {' '}See how fees work.
      </span>
    </a>
  )
}

function Breakdown({ food, delivery, rateBps, title }: { food: number; delivery: number; rateBps: number; title: string }) {
  const s = usePlatform()
  const ours = Math.round(food * rateBps / 10000)
  const service = serviceFee(food + delivery, s)
  return (
    <div className="card fee-breakdown">
      <h2>{title}</h2>
      <div className="item"><span>Customer pays for food</span><span>{pounds(food)}</span></div>
      {delivery > 0 && <div className="item"><span>Customer pays for delivery</span><span>{pounds(delivery)}</span></div>}
      <div className="item muted"><span>Customer’s service fee (covers card costs, not yours)</span><span>{pounds(service)}</span></div>
      <div className="item"><span>BiteBY fee ({percent(rateBps)} of the food)</span><span>−{pounds(ours)}</span></div>
      <div className="item total"><strong>You get</strong><strong>{pounds(food + delivery - ours)}</strong></div>
    </div>
  )
}

// Everything a cook pays, in plain words, with a calculator. Public, so people
// can read it before they sign up.
export default function Fees() {
  const s = usePlatform()
  const welcome = useWelcomeHeadline()
  const [food, setFood] = useState('20')
  const [delivery, setDelivery] = useState('0')
  const foodP = Math.max(0, Math.round((parseFloat(food) || 0) * 100))
  const deliveryP = Math.max(0, Math.round((parseFloat(delivery) || 0) * 100))
  const intro = Math.min(s.intro_commission_bps, s.commission_bps)
  const hasIntro = s.intro_days > 0 && intro < s.commission_bps

  return (
    <div className="stack">
      <p><a href="/sell" onClick={link('/sell')}>← Sell on BiteBY</a></p>
      {welcome && <span className="offer-badge">{welcome}</span>}
      <h1>How fees work</h1>
      <p>Simple and the same for every cook. You only pay when you sell.</p>

      <ul className="fee-points">
        <li><strong>No sign-up fee and no monthly fee.</strong> If you don’t sell, you pay nothing.</li>
        <li><strong>BiteBY fee: {percent(s.commission_bps)} of the food price.</strong> That’s all BiteBY takes.{hasIntro && <> For your first {s.intro_days} days of selling it’s {intro === 0 ? '0%: BiteBY takes nothing' : `only ${percent(intro)}`}.</>}</li>
        <li><strong>Delivery fees are all yours.</strong> BiteBY takes nothing from them.</li>
        <li><strong>No card fees for you.</strong> Customers pay a small service fee ({pounds(serviceFee(2000, s))} on a £20 order) that covers the cost of card payments, Apple Pay and Google Pay. Nothing else comes off your money.</li>
        <li><strong>Declined orders cost you nothing.</strong> The customer gets all their money back and you pay no fees.</li>
        <li><strong>Discount codes:</strong> our fee is worked out on what the customer actually pays after your discount.</li>
        <li><strong>Getting paid:</strong> Stripe pays your money straight into your bank account, usually within a few working days. Your very first payout can take about a week.</li>
        <li><strong>No surprises:</strong> if our fee ever changes, we’ll tell you at least 30 days before.</li>
      </ul>

      <div className="card stack">
        <h2>Try it</h2>
        <div className="row">
          <label>Food price (£)<input type="number" min="0" max="1000" step="0.5" inputMode="decimal" value={food} onChange={(e) => setFood(e.target.value)} /></label>
          <label>Delivery fee (£)<input type="number" min="0" max="100" step="0.5" inputMode="decimal" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></label>
        </div>
      </div>
      {hasIntro && <Breakdown food={foodP} delivery={deliveryP} rateBps={intro} title={`Your first ${s.intro_days} days`} />}
      <Breakdown food={foodP} delivery={deliveryP} rateBps={s.commission_bps} title={hasIntro ? 'After that' : 'Each order'} />

      <p className="muted small">
        For comparison, big takeaway apps usually keep around 30% of each order. Payments are handled by Stripe, a trusted payment
        company used by millions of businesses. Full details are in the <a href="/seller-terms" onClick={link('/seller-terms')}>seller terms</a>.
      </p>
    </div>
  )
}
