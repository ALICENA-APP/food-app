import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Icon } from './icons'

// Stamp card: "your 6th order is 20% off". The cook sets it up and pays for
// the reward; the database counts stamps and applies the reward at checkout.

export type StampCard = { needed: number; percent: number; stamps: number; reward_ready: boolean }

export function useStampCard(shopId: string | undefined) {
  const [card, setCard] = useState<StampCard | null>(null)
  useEffect(() => {
    if (!shopId) return
    supabase?.rpc('my_stamp_card', { p_shop: shopId }).then(({ data }) => setCard((data as StampCard | null) ?? null), () => {})
  }, [shopId])
  return card
}

export const rewardOff = (card: StampCard, subtotal: number) => Math.min(subtotal, Math.round((subtotal * card.percent) / 100))

// On the shop page (shows nothing when the cook has no stamp card).
export function ShopStampCard({ shopId }: { shopId: string }) {
  const card = useStampCard(shopId)
  return card ? <StampCardView card={card} /> : null
}

export function StampCardView({ card }: { card: StampCard }) {
  return (
    <div className={`stamp-card ${card.reward_ready ? 'ready' : ''}`}>
      <div className="stamp-head">
        <strong className="h-icon"><Icon name="star" size={16} filled /> Stamp card</strong>
        <span className="small">{card.reward_ready ? `${card.percent}% off this order` : `Your ${ordinal(card.needed + 1)} order is ${card.percent}% off`}</span>
      </div>
      <div className="stamps" aria-label={`${card.stamps} of ${card.needed} stamps`}>
        {Array.from({ length: card.needed }, (_, i) => (
          <span key={i} className={`stamp ${i < card.stamps ? 'on' : ''}`}>{i < card.stamps && <Icon name="check" size={14} />}</span>
        ))}
        <span className="stamp reward">{card.percent}%</span>
      </div>
      <span className="tiny stamp-note">
        {card.reward_ready ? 'Your reward comes off automatically at checkout.' : `${card.needed - card.stamps} more ${card.needed - card.stamps === 1 ? 'order' : 'orders'} to go. A stamp for every finished order.`}
      </span>
    </div>
  )
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// The cook's settings, on Discount codes.
export function StampCardSettings({ shopId }: { shopId: string }) {
  const [loaded, setLoaded] = useState(false)
  const [exists, setExists] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [needed, setNeeded] = useState(5)
  const [percent, setPercent] = useState(20)
  const [message, setMessage] = useState('')

  useEffect(() => {
    supabase!.from('shop_loyalty').select('enabled, stamps_needed, reward_percent').eq('shop_id', shopId).maybeSingle().then(({ data }) => {
      if (data) {
        setExists(true)
        setEnabled(data.enabled)
        setNeeded(data.stamps_needed)
        setPercent(data.reward_percent)
      }
      setLoaded(true)
    })
  }, [shopId])

  async function save(next: { enabled?: boolean; needed?: number; percent?: number }) {
    const row = { enabled: next.enabled ?? enabled, stamps_needed: next.needed ?? needed, reward_percent: next.percent ?? percent }
    setEnabled(row.enabled)
    setNeeded(row.stamps_needed)
    setPercent(row.reward_percent)
    const { error } = exists
      ? await supabase!.from('shop_loyalty').update(row).eq('shop_id', shopId)
      : await supabase!.from('shop_loyalty').insert({ shop_id: shopId, ...row })
    if (error) return setMessage(error.message)
    setExists(true)
    setMessage('Saved')
  }

  if (!loaded) return null
  return (
    <div className="card stack stamp-settings" style={{ gap: 10 }}>
      <div className="sum-row">
        <span className="set-icon"><Icon name="star" size={22} filled /></span>
        <span className="sum-text">
          <strong>Stamp card</strong>
          <span className="small muted">Reward regulars automatically. A stamp for every finished order.</span>
        </span>
        <input type="checkbox" className="switch" checked={enabled} onChange={(e) => save({ enabled: e.target.checked })} aria-label="Stamp card" />
      </div>
      {enabled && (
        <>
          <div className="row">
            <label>
              Stamps needed
              <select value={needed} onChange={(e) => save({ needed: Number(e.target.value) })}>
                {[3, 4, 5, 6, 8, 10].map((n) => <option key={n} value={n}>{n} orders</option>)}
              </select>
            </label>
            <label>
              Reward
              <select value={percent} onChange={(e) => save({ percent: Number(e.target.value) })}>
                {[10, 15, 20, 25, 30, 50].map((n) => <option key={n} value={n}>{n}% off</option>)}
              </select>
            </label>
          </div>
          <StampCardView card={{ needed, percent, stamps: Math.max(0, needed - 2), reward_ready: false }} />
          <p className="muted tiny">Customers see this on your shop. The reward comes off your food price, like a discount code, and isn’t used when they enter a code.</p>
        </>
      )}
      {message && <p className={message === 'Saved' ? 'status small' : 'error small'} role="status">{message}</p>}
    </div>
  )
}
