import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { hygieneWords } from '../lib/hygiene'
import type { Shop, Verification } from '../lib/types'

type Step = { label: string; to: string; done: boolean }

// "Get your shop ready": the things that make customers order, ticked off as
// the cook does them. Disappears once everything is done.
export function SetupChecklist({ shop, refresh }: { shop: Shop; refresh: number }) {
  const [steps, setSteps] = useState<Step[] | null>(null)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const [products, hours, hygiene] = await Promise.all([
        db.from('products').select('id, product_images(path)').eq('shop_id', shop.id).eq('status', 'published'),
        db.from('shop_hours').select('weekday', { count: 'exact', head: true }).eq('shop_id', shop.id),
        db.from('seller_verifications').select('id', { count: 'exact', head: true })
          .eq('seller_account_id', shop.seller_account_id).eq('kind', 'hygiene_rating').neq('status', 'rejected'),
      ])
      const dishes = (products.data ?? []) as { id: string; product_images: { path: string }[] }[]
      setSteps([
        { label: 'Add your logo and a cover photo', to: '/sell/shop', done: Boolean(shop.logo_path && shop.cover_path) },
        { label: 'Tell customers your story', to: '/sell/shop', done: Boolean(shop.story && shop.story.trim().length >= 30) },
        { label: 'Put at least 3 dishes on your menu', to: '/sell/products', done: dishes.length >= 3 },
        { label: 'Add a photo to every dish', to: '/sell/products', done: dishes.length > 0 && dishes.every((d) => d.product_images?.length > 0) },
        { label: 'Set your opening hours', to: '/sell/shop', done: (hours.count ?? 0) > 0 },
        { label: 'Add your food hygiene rating', to: '#hygiene', done: (hygiene.count ?? 0) > 0 },
      ])
    })()
  }, [shop, refresh])

  if (!steps || steps.every((s) => s.done)) return null
  const done = steps.filter((s) => s.done).length
  return (
    <div className="card checklist stack" style={{ gap: 8 }}>
      <div className="item"><h2 style={{ margin: 0 }}>Get your shop ready</h2><span className="muted small">{done} of {steps.length} done</span></div>
      <div className="bar"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <div>
        {steps.map((s) => s.done ? (
          <span key={s.label} className="done"><span className="box"><Icon name="check" size={14} /></span>{s.label}</span>
        ) : (
          <a key={s.label} href={s.to} onClick={s.to.startsWith('#') ? (e) => { e.preventDefault(); document.getElementById(s.to.slice(1))?.scrollIntoView({ behavior: 'smooth' }) } : link(s.to)}>
            <span className="box" />{s.label}<Icon name="chevron" size={16} />
          </a>
        ))}
      </div>
    </div>
  )
}

// The cook's food hygiene rating from their council inspection. It shows on
// the shop once the BiteBY team has checked it.
export function HygieneCard({ accountId, onSaved }: { accountId: string; onSaved: () => void }) {
  const [rows, setRows] = useState<Verification[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [rating, setRating] = useState('5')
  const [date, setDate] = useState('')
  const [fhrs, setFhrs] = useState('')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase!.from('seller_verifications').select('*').eq('seller_account_id', accountId).eq('kind', 'hygiene_rating').order('created_at', { ascending: false })
    setRows((data ?? []) as Verification[])
  }, [accountId])
  useEffect(() => {
    load()
  }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    // Accept a link to the FSA page or just its number.
    const id = fhrs.trim().match(/(\d{3,12})\/?\s*$/)?.[1] ?? null
    if (fhrs.trim() && !id) return setMessage('Paste the link to your rating on ratings.food.gov.uk, or leave it empty.')
    const { error } = await supabase!.from('seller_verifications').insert({
      seller_account_id: accountId, kind: 'hygiene_rating', rating: Number(rating), rating_date: date || null, fhrs_id: id,
    })
    if (error) return setMessage(error.message)
    setAdding(false)
    load()
    onSaved()
  }

  async function remove(id: string) {
    await supabase!.from('seller_verifications').delete().eq('id', id)
    load()
    onSaved()
  }

  if (!rows) return null
  const current = rows.find((r) => r.status === 'accepted')
  const pending = rows.find((r) => r.status === 'pending')
  const rejected = !current && !pending ? rows.find((r) => r.status === 'rejected') : undefined

  return (
    <div className="card stack" id="hygiene" style={{ gap: 8 }}>
      <h2 style={{ margin: 0 }}>Food hygiene rating</h2>
      <p className="muted small">After your council inspects your kitchen you get a rating from 0 to 5. Showing it builds trust: shops with a rating get a badge on their page.</p>
      {current && <p className="small"><span className="tag green">Shown on your shop</span> Rating {current.rating}: {hygieneWords(current.rating ?? 0).toLowerCase()}</p>}
      {pending && (
        <div className="item">
          <span className="small"><span className="tag">Being checked</span> Rating {pending.rating}</span>
          <button type="button" className="link" onClick={() => remove(pending.id)}>Remove</button>
        </div>
      )}
      {rejected && <p className="small error">We couldn’t confirm your last rating. Check the details and add it again.</p>}
      {!pending && !adding && (
        <button type="button" className="secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>{current ? 'Add a newer rating' : 'Add my rating'}</button>
      )}
      {adding && (
        <form className="stack" onSubmit={save}>
          <div className="row">
            <label>Rating
              <select value={rating} onChange={(e) => setRating(e.target.value)}>
                {[5, 4, 3, 2, 1, 0].map((n) => <option key={n} value={n}>{n} · {hygieneWords(n)}</option>)}
              </select>
            </label>
            <label>Inspected on<input type="date" max={new Date().toISOString().slice(0, 10)} value={date} onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <label>Link to your rating (optional)
            <input value={fhrs} onChange={(e) => setFhrs(e.target.value)} placeholder="ratings.food.gov.uk/business/…" />
          </label>
          <p className="muted tiny">Find yourself on ratings.food.gov.uk and paste the link. It helps us check it quickly.</p>
          <div className="row">
            <button type="submit">Send to check</button>
            <button type="button" className="secondary" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </form>
      )}
      {message && <p className="error small">{message}</p>}
    </div>
  )
}
