import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { StampCardSettings } from '../lib/loyalty'
import { offerLabel as discountLabel } from '../lib/discounts'

export type Discount = {
  id: string
  shop_id: string
  code: string
  kind: 'percent' | 'amount'
  value: number
  min_spend_pence: number
  new_customers_only: boolean
  max_uses: number | null
  ends_on: string | null
  show_on_shop: boolean
  active: boolean
}

const niceDate = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

// Discount codes the cook makes for their own shop. The discount comes off the
// cook's food price; BiteBY's fee is then on what the customer actually pays.
export default function Discounts() {
  const [shopId, setShopId] = useState<string | null | undefined>(undefined)
  const [list, setList] = useState<Discount[]>([])
  const [uses, setUses] = useState<Record<string, number>>({})
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (shop: string) => {
    const db = supabase!
    const { data } = await db.from('shop_discounts').select('*').eq('shop_id', shop).order('created_at', { ascending: false })
    setList((data ?? []) as Discount[])
    const { data: orders } = await db.from('orders').select('discount_id, status').eq('shop_id', shop).not('discount_id', 'is', null).limit(5000)
    const count: Record<string, number> = {}
    for (const o of orders ?? []) {
      if (!['declined', 'cancelled', 'expired', 'refunded'].includes(o.status)) count[o.discount_id] = (count[o.discount_id] ?? 0) + 1
    }
    setUses(count)
  }, [])

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      if (!account) return setShopId(null)
      const { data: shops } = await db.from('shops').select('id').eq('seller_account_id', account.id).limit(1)
      const id = shops?.[0]?.id ?? null
      setShopId(id)
      if (id) load(id)
    })()
  }, [load])

  if (shopId === undefined) return <p className="muted">Loading…</p>
  if (!shopId) {
    return (
      <div className="card">
        <p>Set up your shop first, then come back to make discount codes.</p>
        <a className="button" href="/sell/shop" onClick={link('/sell/shop')}>Set up shop</a>
      </div>
    )
  }

  async function update(d: Discount, patch: Partial<Discount>) {
    await supabase!.from('shop_discounts').update(patch).eq('id', d.id)
    load(shopId!)
  }

  async function remove(d: Discount) {
    if (!confirm(`Delete the code ${d.code}? Customers won’t be able to use it any more.`)) return
    const { error } = await supabase!.from('shop_discounts').delete().eq('id', d.id)
    if (error) await update(d, { active: false })
    else load(shopId!)
  }

  return (
    <div className="stack">
      <h1>Offers</h1>
      <p className="muted">
        A stamp card rewards regulars automatically. Or make a code like WELCOME10 to bring in new customers. Share it with your shop link, or show it on your shop page.
        The discount comes off your food price, and the BiteBY fee is worked out on what the customer pays after the discount.
      </p>

      <StampCardSettings shopId={shopId!} />

      {adding ? <NewDiscount shopId={shopId} onDone={() => { setAdding(false); load(shopId) }} onCancel={() => setAdding(false)} />
        : <button type="button" onClick={() => setAdding(true)}><Icon name="plus" size={18} /> Make a code</button>}

      {list.length === 0 && !adding && <p className="muted">No codes yet.</p>}
      {list.map((d) => {
        const ended = d.ends_on !== null && d.ends_on < new Date().toISOString().slice(0, 10)
        const usedUp = d.max_uses !== null && (uses[d.id] ?? 0) >= d.max_uses
        return (
          <article key={d.id} className="card stack" style={{ gap: 6 }}>
            <div className="item">
              <strong className="code-chip">{d.code}</strong>
              <span className={`tag ${d.active && !ended && !usedUp ? 'green' : 'grey'}`}>
                {!d.active ? 'Off' : ended ? 'Ended' : usedUp ? 'Used up' : 'On'}
              </span>
            </div>
            <p className="small">{discountLabel(d)}</p>
            <p className="muted tiny">
              Used {uses[d.id] ?? 0}{d.max_uses ? ` of ${d.max_uses}` : ''} {(uses[d.id] ?? 0) === 1 ? 'time' : 'times'}
              {d.ends_on && ` · ends ${niceDate(d.ends_on)}`} · once per customer · {d.show_on_shop ? 'shown on your shop page' : 'secret (only people you tell)'}
            </p>
            <div className="row wrap">
              <button type="button" className="secondary small-btn" onClick={() => update(d, { active: !d.active })}>{d.active ? 'Turn off' : 'Turn on'}</button>
              <button type="button" className="secondary small-btn" onClick={() => update(d, { show_on_shop: !d.show_on_shop })}>{d.show_on_shop ? 'Hide from shop page' : 'Show on shop page'}</button>
              <button type="button" className="secondary small-btn danger" onClick={() => remove(d)}>Delete</button>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function NewDiscount({ shopId, onDone, onCancel }: { shopId: string; onDone: () => void; onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [kind, setKind] = useState<'percent' | 'amount'>('percent')
  const [value, setValue] = useState('10')
  const [minSpend, setMinSpend] = useState('')
  const [firstOnly, setFirstOnly] = useState(false)
  const [maxUses, setMaxUses] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [show, setShow] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (clean.length < 3 || clean.length > 20) return setError('Use 3 to 20 letters and numbers, like WELCOME10.')
    const n = Number(value)
    const amount = kind === 'percent' ? Math.round(n) : Math.round(n * 100)
    if (kind === 'percent' && !(amount >= 1 && amount <= 50)) return setError('Choose between 1% and 50% off.')
    if (kind === 'amount' && !(amount >= 50 && amount <= 5000)) return setError('Choose between £0.50 and £50 off.')
    const min = minSpend ? Math.round(Number(minSpend) * 100) : 0
    if (!(min >= 0 && min <= 100000)) return setError('Check the minimum spend.')
    const max = maxUses ? Math.round(Number(maxUses)) : null
    if (max !== null && !(max >= 1 && max <= 10000)) return setError('Check how many times it can be used.')
    setBusy(true)
    const { error: err } = await supabase!.from('shop_discounts').insert({
      id: crypto.randomUUID(), shop_id: shopId, code: clean, kind, value: amount, min_spend_pence: min,
      new_customers_only: firstOnly, max_uses: max, ends_on: endsOn || null, show_on_shop: show,
    })
    setBusy(false)
    if (err) return setError(err.code === '23505' ? 'You already have a code with that name.' : err.message.includes('row-level') ? 'You can have up to 20 codes. Delete an old one first.' : err.message)
    onDone()
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <label>
        Code
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} maxLength={20} placeholder="WELCOME10" autoCapitalize="characters" required />
      </label>
      <div className="segmented">
        <label className={kind === 'percent' ? 'on not_present' : ''}><input type="radio" checked={kind === 'percent'} onChange={() => { setKind('percent'); setValue('10') }} /> % off</label>
        <label className={kind === 'amount' ? 'on not_present' : ''}><input type="radio" checked={kind === 'amount'} onChange={() => { setKind('amount'); setValue('2') }} /> £ off</label>
      </div>
      <label>
        {kind === 'percent' ? 'Percent off the food (1 to 50)' : 'Pounds off the food'}
        <input type="number" inputMode="decimal" min={kind === 'percent' ? 1 : 0.5} max={kind === 'percent' ? 50 : 50} step={kind === 'percent' ? 1 : 0.5} value={value} onChange={(e) => setValue(e.target.value)} required />
      </label>
      <label>
        Minimum spend on food (£, optional)
        <input type="number" inputMode="decimal" min={0} step={0.5} value={minSpend} onChange={(e) => setMinSpend(e.target.value)} placeholder="No minimum" />
      </label>
      <label>
        How many times it can be used in total (optional)
        <input type="number" inputMode="numeric" min={1} max={10000} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="No limit" />
      </label>
      <label>
        Last day (optional)
        <input type="date" value={endsOn} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setEndsOn(e.target.value)} />
      </label>
      <label className="check"><input type="checkbox" checked={firstOnly} onChange={(e) => setFirstOnly(e.target.checked)} /> Only for people ordering from me for the first time</label>
      <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show it on my shop page</label>
      <p className="muted tiny">Each customer can use a code once.</p>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save code'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  )
}
