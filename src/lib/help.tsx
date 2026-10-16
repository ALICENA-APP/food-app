import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { askToSignIn, useSession } from './session'
import { link } from './router'

export type Topic = 'missing' | 'wrong' | 'quality' | 'late' | 'allergy' | 'payment' | 'account' | 'selling' | 'other'

export const TOPIC_LABEL: Record<Topic, string> = {
  missing: 'Something was missing',
  wrong: 'Wrong item or order',
  quality: 'Food quality',
  late: 'Late or didn’t arrive',
  allergy: 'Allergy or made me ill',
  payment: 'Payment or refund',
  account: 'My account',
  selling: 'Selling on BiteBY',
  other: 'Something else',
}

const ORDER_TOPICS: Topic[] = ['missing', 'wrong', 'quality', 'late', 'allergy', 'payment', 'other']
const SELLER_ORDER_TOPICS: Topic[] = ['payment', 'other']
const GENERAL_TOPICS: Topic[] = ['account', 'payment', 'selling', 'allergy', 'other']

export type HelpRequest = {
  id: string
  topic: Topic
  details: string
  status: 'open' | 'resolved'
  admin_reply: string | null
  created_at: string
  resolved_at: string | null
  order_id: string | null
}

// A short form that sends a message to the BiteBY team, about an order or in general.
export function HelpForm({ orderId, seller, plain, onDone }: { orderId?: string; seller?: boolean; plain?: boolean; onDone?: () => void }) {
  const box = plain ? 'stack' : 'card stack'
  const { session } = useSession()
  const topics = orderId ? (seller ? SELLER_ORDER_TOPICS : ORDER_TOPICS) : GENERAL_TOPICS
  const [topic, setTopic] = useState<Topic>(topics[0])
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)

  if (!session) {
    return (
      <div className={box}>
        <p>Sign in to send a message to the BiteBY team, so we can reply to you.</p>
        <button type="button" onClick={() => askToSignIn(location.pathname)}>Sign in</button>
      </div>
    )
  }

  if (sent) {
    return (
      <div className={box}>
        <p className="tick">Sent. The BiteBY team will reply here in the app.</p>
        <a href="/help/requests" onClick={link('/help/requests')}>See your messages to BiteBY</a>
      </div>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (details.trim().length < 5) return setError('Tell us a little more about what happened.')
    setBusy(true)
    const { error: err } = await supabase!.rpc('ask_for_help', { p_topic: topic, p_details: details.trim(), p_order: orderId ?? null })
    setBusy(false)
    if (err) return setError(err.message)
    setSent(true)
    onDone?.()
  }

  return (
    <form className={box} onSubmit={submit}>
      <label>
        What’s it about?
        <select value={topic} onChange={(e) => setTopic(e.target.value as Topic)}>
          {topics.map((t) => <option key={t} value={t}>{seller && t === 'other' ? 'A problem with this customer or order' : TOPIC_LABEL[t]}</option>)}
        </select>
      </label>
      {topic === 'allergy' && (
        <p className="status small">If someone is having a serious reaction, call 999 now. For advice, call NHS 111.</p>
      )}
      <label>
        What happened?
        <textarea rows={4} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)}
          placeholder={orderId ? 'For example: the rice was missing from my order.' : 'How can we help?'} />
      </label>
      {!orderId && !seller && <p className="muted small">About an order? Open it under Orders and tap “Report a problem”, so we can see the details.</p>}
      {error && <p className="error small">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send to the BiteBY team'}</button>
    </form>
  )
}

// Everything you've sent the team, and their replies.
export function MyRequests() {
  const [list, setList] = useState<HelpRequest[] | null>(null)
  useEffect(() => {
    supabase!.from('help_requests').select('*').order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setList((data ?? []) as HelpRequest[]))
  }, [])
  return (
    <div className="stack">
      <a className="back" href="/help" onClick={link('/help')}>← Help</a>
      <h1>Messages to BiteBY</h1>
      {list === null && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">You haven’t sent the team anything yet.</p>}
      {list?.map((r) => (
        <div key={r.id} className="card stack" style={{ gap: 6 }}>
          <div className="item">
            <strong>{TOPIC_LABEL[r.topic]}</strong>
            <span className={`tag ${r.status === 'open' ? 'grey' : 'green'}`}>{r.status === 'open' ? 'Waiting for a reply' : 'Answered'}</span>
          </div>
          <p className="muted tiny">{new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}{r.order_id && ' · about an order'}</p>
          <p className="small">{r.details}</p>
          {r.admin_reply && (
            <div className="bubble-reply">
              <strong className="small">BiteBY team</strong>
              <p className="small">{r.admin_reply}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
