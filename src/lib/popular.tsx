import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { askToSignIn, useSession } from './session'
import { Icon } from './icons'

// How many paid orders each dish had in the last 90 days. The database only
// returns dishes with 3 or more, so small numbers never show.
export function useOrderCounts(ids: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const key = ids.slice(0, 200).sort().join(',')
  useEffect(() => {
    if (!key) return
    supabase!.rpc('dish_order_counts', { p_products: key.split(',') }).then(({ data }) => {
      const next: Record<string, number> = {}
      for (const r of (data ?? []) as { product_id: string; orders: number }[]) next[r.product_id] = r.orders
      setCounts(next)
    })
  }, [key])
  return counts
}

// How many reviewers said they loved each dish.
export function useLovedCounts(ids: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const key = ids.slice(0, 200).sort().join(',')
  useEffect(() => {
    if (!key) return
    supabase!.rpc('dish_loved_counts', { p_products: key.split(',') }).then(({ data }) => {
      const next: Record<string, number> = {}
      for (const r of (data ?? []) as { product_id: string; loved: number }[]) next[r.product_id] = r.loved
      setCounts(next)
    })
  }, [key])
  return counts
}

// Rounded down, so it reads "Ordered 20+ times" rather than an exact count.
export function popularLabel(orders: number | undefined) {
  if (!orders) return ''
  const steps = [500, 200, 100, 50, 20, 10]
  const step = steps.find((s) => orders >= s)
  return step ? `Ordered ${step}+ times` : 'Popular'
}

export function PopularTag({ orders }: { orders?: number }) {
  const label = popularLabel(orders)
  return label ? <span className="tag popular">{label}</span> : null
}

// On a sold-out dish: get an alert when it can be ordered again.
export function StockAlertButton({ productId }: { productId: string }) {
  const { session } = useSession()
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const userId = session?.user.id

  useEffect(() => {
    if (!userId) return setOn(false)
    supabase!.from('stock_alerts').select('product_id').eq('user_id', userId).eq('product_id', productId).maybeSingle()
      .then(({ data }) => setOn(Boolean(data)))
  }, [userId, productId])

  async function toggle() {
    if (!session) return askToSignIn(location.pathname)
    setError('')
    const db = supabase!
    const { error: err } = on
      ? await db.from('stock_alerts').delete().eq('user_id', userId!).eq('product_id', productId)
      : await db.from('stock_alerts').insert({ product_id: productId })
    if (err) return setError(err.message.includes('row-level') ? 'You can wait for up to 50 dishes at once.' : err.message)
    setOn(!on)
  }

  if (on === null) return null
  return (
    <div className="stack" style={{ gap: 6 }}>
      <button type="button" className={on ? 'secondary' : ''} onClick={toggle}>
        <Icon name="bell" size={18} /> {on ? 'We’ll tell you when it’s back' : 'Tell me when it’s back'}
      </button>
      {on && <p className="muted tiny">You’ll get an alert as soon as the cook has it again. Tap again to cancel.</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
