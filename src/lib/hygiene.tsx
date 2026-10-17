import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { navigate } from './router'
import { askToSignIn, useSession } from './session'
import { Icon } from './icons'

export type Hygiene = { rating: number; rating_date: string | null; fhrs_id: string | null }

// Ratings the BiteBY team has checked, by shop.
export function useHygiene(shopIds: string[]) {
  const [map, setMap] = useState<Record<string, Hygiene>>({})
  const key = [...new Set(shopIds)].sort().join(',')
  useEffect(() => {
    if (!key) return
    supabase!.rpc('shop_hygiene', { p_shops: key.split(',') }).then(({ data }) => {
      const next: Record<string, Hygiene> = {}
      for (const r of (data ?? []) as (Hygiene & { shop_id: string })[]) next[r.shop_id] = r
      setMap(next)
    })
  }, [key])
  return map
}

export const fsaLink = (id: string) => `https://ratings.food.gov.uk/business/${encodeURIComponent(id)}`

// A small version of the green sticker: the rating out of 5.
export function HygieneBadge({ hygiene }: { hygiene?: Hygiene }) {
  if (!hygiene) return null
  return (
    <span className="hygiene" title="Food hygiene rating from the local council, checked by BiteBY">
      <span className="lbl">Food hygiene</span>
      <span className="scale">{[0, 1, 2, 3, 4, 5].map((n) => <span key={n} className={n === hygiene.rating ? 'on' : ''}>{n}</span>)}</span>
    </span>
  )
}

export function hygieneWords(r: number) {
  return ['Urgent improvement necessary', 'Major improvement necessary', 'Improvement necessary', 'Generally satisfactory', 'Good', 'Very good'][r] ?? ''
}

// Party and event orders, sent to the cook as a question they can reply to.
export function CateringTile({ shopId, cookName }: { shopId: string; cookName: string }) {
  const { session } = useSession()
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState('')
  const [people, setPeople] = useState('')
  const [budget, setBudget] = useState('')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (!open) {
    return (
      <button type="button" className="tile report-tile" onClick={() => (session ? setOpen(true) : askToSignIn(location.pathname))}>
        <span className="ic" style={{ background: 'var(--yellow-soft)' }}><Icon name="users" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>Catering for an event</span>
          <span className="s">{cookName} takes party and event orders. Ask for a quote.</span>
        </span>
      </button>
    )
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    setError('')
    const n = Number(people)
    if (!date) return setError('Choose the date of your event.')
    if (!(n >= 2 && n <= 1000)) return setError('How many people is it for?')
    const when = new Date(date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
    const body = [`Catering request`, `Date: ${when}`, `People: ${n}`, budget && `Budget: about £${budget}`, details.trim()].filter(Boolean).join('\n')
    setBusy(true)
    const { data, error: err } = await supabase!.rpc('ask_cook', { p_shop: shopId, p_body: body })
    setBusy(false)
    if (err) return setError(err.message.includes('Sign in') ? 'Sign in first, then send your request.' : err.message)
    navigate(`/messages/${data.chat_id}`)
  }

  const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10)
  return (
    <form className="card stack" onSubmit={send}>
      <strong>Catering request to {cookName}</strong>
      <div className="row">
        <label>Date<input type="date" min={tomorrow} value={date} onChange={(e) => setDate(e.target.value)} required /></label>
        <label>People<input type="number" inputMode="numeric" min={2} max={1000} value={people} onChange={(e) => setPeople(e.target.value)} required /></label>
      </div>
      <label>Budget in £ (optional)<input type="number" inputMode="decimal" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} /></label>
      <label>What would you like?<textarea rows={3} maxLength={700} value={details} onChange={(e) => setDetails(e.target.value)} placeholder="e.g. Jollof and chicken for a birthday, 2 vegetarians, collection at 4pm" /></label>
      <p className="muted tiny">The cook replies in your Messages with a quote. Nothing is charged until you order.</p>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}
