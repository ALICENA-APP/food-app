import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Icon } from './icons'
import { pounds } from './types'

export type AppliedCode = { code: string; discount_pence: number }
export type Offer = { id: string; code: string; kind: 'percent' | 'amount'; value: number; min_spend_pence: number; new_customers_only: boolean; ends_on: string | null }

export function offerLabel(o: Pick<Offer, 'kind' | 'value' | 'min_spend_pence' | 'new_customers_only'>) {
  const off = o.kind === 'percent' ? `${o.value}% off` : `${pounds(o.value)} off`
  const when = [o.new_customers_only && 'your first order', o.min_spend_pence > 0 && `food over ${pounds(o.min_spend_pence)}`].filter(Boolean).join(', ')
  return when ? `${off} ${when}` : `${off} your food`
}

// Codes a cook shows on their shop page.
export function useShopOffers(shopId: string | undefined) {
  const [offers, setOffers] = useState<Offer[]>([])
  useEffect(() => {
    if (!shopId) return
    const today = new Date().toISOString().slice(0, 10)
    supabase!.from('shop_discounts').select('id, code, kind, value, min_spend_pence, new_customers_only, ends_on, show_on_shop, active')
      .eq('shop_id', shopId).eq('show_on_shop', true).eq('active', true).order('created_at', { ascending: false }).limit(3)
      .then(({ data }) => setOffers(((data ?? []) as (Offer & { ends_on: string | null })[]).filter((o) => !o.ends_on || o.ends_on >= today)))
  }, [shopId])
  return offers
}

export function ShopOffers({ shopId }: { shopId: string }) {
  const offers = useShopOffers(shopId)
  const [copied, setCopied] = useState('')
  if (!offers.length) return null
  return (
    <div className="offers">
      {offers.map((o) => (
        <button key={o.id} type="button" className="offer" onClick={() => {
          navigator.clipboard?.writeText(o.code).catch(() => {})
          setCopied(o.code)
        }}>
          <Icon name="tag" size={16} />
          <span className="what"><strong>{offerLabel(o)}</strong></span>
          <span className="code-chip">{copied === o.code ? 'Copied' : o.code}</span>
        </button>
      ))}
    </div>
  )
}

// The code box in the basket. Checks the code with the server, which also
// checks it again when the order is placed.
export function DiscountBox({ shopId, subtotal, applied, onChange }: {
  shopId: string; subtotal: number; applied: AppliedCode | null; onChange: (a: AppliedCode | null) => void
}) {
  const offers = useShopOffers(shopId)
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function check(value: string) {
    const clean = value.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!clean) return
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase!.rpc('preview_discount', { p_shop: shopId, p_code: clean, p_subtotal: subtotal })
    setBusy(false)
    if (err) {
      onChange(null)
      return setError(err.message)
    }
    onChange({ code: data.code, discount_pence: data.discount_pence })
    setOpen(false)
  }

  // Basket changed: check the amount again.
  const appliedCode = applied?.code
  useEffect(() => {
    if (appliedCode) check(appliedCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subtotal, shopId])

  if (applied) {
    return (
      <div className="item discount-on">
        <span className="tick small"><Icon name="tag" size={16} /> {applied.code} saves you {pounds(Math.min(applied.discount_pence, subtotal))}</span>
        <button type="button" className="link" onClick={() => { onChange(null); setCode('') }}>Remove</button>
      </div>
    )
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {offers.length > 0 && !open && offers.map((o) => (
        <button key={o.id} type="button" className="offer" onClick={() => check(o.code)}>
          <Icon name="tag" size={18} /><span><strong>{offerLabel(o)}</strong><span className="small"> · tap to use {o.code}</span></span>
        </button>
      ))}
      {open ? (
        <div className="row">
          <input aria-label="Discount code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} placeholder="Code" autoCapitalize="characters"
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); check(code) } }} />
          <button type="button" className="secondary" disabled={busy || !code.trim()} onClick={() => check(code)}>{busy ? 'Checking…' : 'Apply'}</button>
        </div>
      ) : (
        <button type="button" className="link" style={{ alignSelf: 'flex-start', paddingLeft: 0 }} onClick={() => setOpen(true)}>Have a discount code?</button>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
