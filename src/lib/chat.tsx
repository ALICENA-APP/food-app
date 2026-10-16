import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase } from './supabase'

type Message = { id: number; from_seller: boolean; body: string; created_at: string }

function time(iso: string) {
  const d = new Date(iso)
  const today = d.toDateString() === new Date().toDateString()
  return d.toLocaleString('en-GB', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// Chat on one order between the customer and the cook. Live when Realtime is
// connected, with a check every 20 seconds as a fallback.
export function OrderChat({ orderId, asSeller, otherName }: { orderId: string; asSeller: boolean; otherName: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const { data } = await supabase!.from('order_messages').select('id, from_seller, body, created_at').eq('order_id', orderId).order('created_at').limit(200)
    setMessages(data ?? [])
  }, [orderId])

  useEffect(() => {
    load()
    const db = supabase!
    const timer = window.setInterval(load, 20000)
    const channel = db
      .channel(`chat-${orderId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'food', table: 'order_messages', filter: `order_id=eq.${orderId}` }, () => load())
      .subscribe()
    return () => {
      window.clearInterval(timer)
      db.removeChannel(channel)
    }
  }, [orderId, load])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [messages?.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setSending(true)
    setError('')
    const { data: note, error: err } = await supabase!.rpc('send_order_message', { p_order: orderId, p_body: text })
    setSending(false)
    if (err) return setError(err.message)
    if (typeof note === 'string' && note) setError(note)
    setText('')
    load()
  }

  return (
    <div className="chat">
      <div className="chat-list">
        {messages === null && <p className="muted small">Loading…</p>}
        {messages?.length === 0 && <p className="muted small">No messages yet. Questions about allergies, timing or directions? Ask {otherName} here.</p>}
        {messages?.map((m) => (
          <div key={m.id} className={`bubble ${m.from_seller === asSeller ? 'mine' : ''}`}>
            <span className="story">{m.body}</span>
            <span className="tiny">{time(m.created_at)}</span>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="chat-send" onSubmit={send}>
        <input value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={`Message ${otherName}`} aria-label={`Message ${otherName}`} />
        <button type="submit" disabled={sending || !text.trim()}>Send</button>
      </form>
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
