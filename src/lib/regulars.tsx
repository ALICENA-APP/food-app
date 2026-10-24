import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { Icon } from './icons'

type Info = { count: number; last_sent: string | null; next_allowed: string | null }
type Dish = { id: string; name: string }

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })

// "Tell my regulars": one short update a week to people who've ordered from
// the cook or follow them, sent as an alert (and phone notification).
export function RegularsUpdate({ shopId, shopName }: { shopId: string; shopName: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [dish, setDish] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [sent, setSent] = useState<number | null>(null)

  useEffect(() => {
    supabase!.rpc('my_regulars').then(({ data }) => setInfo(data as Info | null))
    supabase!.from('products').select('id, name').eq('shop_id', shopId).eq('status', 'published').order('name')
      .then(({ data }) => setDishes(data ?? []))
  }, [shopId])

  const dishName = dishes.find((d) => d.id === dish)?.name
  const ideas = dishName
    ? [`${dishName} is back this Saturday!`, `Fresh ${dishName} today, only a few portions`, `Order your ${dishName} for the weekend`]
    : ['New dish on my menu this week!', 'Taking orders for the weekend now', 'Back from my break and cooking again']

  async function send() {
    setBusy(true)
    setMessage('')
    const { data, error } = await supabase!.rpc('send_regulars_update', { p_body: text, p_product: dish || null })
    setBusy(false)
    if (error) return setMessage(error.message)
    setSent(data as number)
    setInfo((i) => (i ? { ...i, last_sent: new Date().toISOString(), next_allowed: new Date(Date.now() + 7 * 864e5).toISOString() } : i))
  }

  if (!info) return null
  const waiting = info.next_allowed && new Date(info.next_allowed).getTime() > Date.now()
  return (
    <details className="card set-sec regulars" open={!waiting}>
      <summary>
        <span className="sum-row">
          <span className="set-icon"><Icon name="bell" size={22} filled /></span>
          <span className="sum-text">
            <strong>Tell my regulars</strong>
            <span className="small muted">
              {sent !== null ? `Sent to ${sent} ${sent === 1 ? 'person' : 'people'}` : waiting ? `Next update from ${day(info.next_allowed!)}` : `${info.count} ${info.count === 1 ? 'person' : 'people'} will get it`}
            </span>
          </span>
        </span>
      </summary>
      <div className="details-body stack" style={{ gap: 10 }}>
        {waiting ? (
          <p className="muted small">You can send one update a week, so customers look forward to them. Your next one can go out on {day(info.next_allowed!)}.</p>
        ) : (
          <>
            <p className="muted small">A short message to people who ordered from you in the last 6 months or follow your shop. One a week.</p>
            <select value={dish} onChange={(e) => setDish(e.target.value)} aria-label="Dish (optional)">
              <option value="">No particular dish</option>
              {dishes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <div className="chips wrap">
              {ideas.map((i) => <button key={i} type="button" className="chip" onClick={() => setText(i.slice(0, 140))}>{i}</button>)}
            </div>
            <textarea rows={2} maxLength={140} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Jollof is back this Saturday!" aria-label="Your update" />
            <p className="muted tiny" style={{ textAlign: 'right' }}>{text.length}/140</p>
            {text.trim().length >= 5 && (
              <div className="notif-preview" aria-label="How it looks">
                <img src="/icon-192.png" alt="" width={36} height={36} />
                <span className="sum-text"><strong>{shopName}</strong><span className="small">{text}</span></span>
              </div>
            )}
            <button type="button" disabled={busy || text.trim().length < 5 || info.count === 0} onClick={send}>
              {busy ? 'Sending…' : info.count === 0 ? 'No one to send to yet' : `Send to ${info.count} ${info.count === 1 ? 'person' : 'people'}`}
            </button>
          </>
        )}
        {message && <p className="error small">{message}</p>}
      </div>
    </details>
  )
}
