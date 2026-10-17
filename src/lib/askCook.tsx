import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { askToSignIn, useSession } from './session'
import { navigate } from './router'
import { Icon } from './icons'

export type ShopChat = {
  id: string; shop_id: string; customer_id: string; customer_name: string; product_id: string | null
  last_message_at: string; customer_read_at: string; seller_read_at: string | null
  shops?: { name: string; slug: string } | null
  products?: { name: string } | null
}
type Message = { id: number; from_seller: boolean; body: string; created_at: string }

export function chatTime(iso: string) {
  const d = new Date(iso)
  const today = d.toDateString() === new Date().toDateString()
  return d.toLocaleString('en-GB', today ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// A tile on dish and shop pages that opens a short "Ask the cook" form.
export function AskCookTile({ shopId, cookName, productId, productName }: { shopId: string; cookName: string; productId?: string; productName?: string }) {
  const { session } = useSession()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const box = useRef<HTMLDivElement>(null)

  // The chat button at the top of the page opens this form.
  useEffect(() => {
    const show = () => {
      setOpen(true)
      setTimeout(() => box.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50)
    }
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])

  if (!open) {
    return (
      <div ref={box}><button type="button" className="tile report-tile" onClick={() => (session ? setOpen(true) : askToSignIn(location.pathname))}>
        <span className="ic ask"><Icon name="chat" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>Ask {cookName}</span>
          <span className="s">Questions about allergies, ingredients or timing? Ask before you order.</span>
        </span>
      </button></div>
    )
  }

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    setError('')
    const { data, error: err } = await supabase!.rpc('ask_cook', { p_shop: shopId, p_body: text, p_product: productId ?? null })
    setBusy(false)
    if (err) return setError(err.message)
    navigate(`/messages/${data.chat_id}`)
  }

  return (
    <div ref={box}><form className="card stack" onSubmit={send}>
      <strong>Ask {cookName}</strong>
      <textarea rows={3} maxLength={1000} autoFocus value={text} onChange={(e) => setText(e.target.value)}
        placeholder={productName ? `e.g. Does the ${productName.toLowerCase()} contain nuts?` : 'e.g. Can you do a mild version?'} />
      <p className="muted tiny">Keep it on BiteBY: phone numbers, links and payment outside the app are hidden.</p>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send'}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form></div>
  )
}

const OPEN_EVENT = 'open-ask-cook'

// A round chat button for the top of shop and dish pages.
export function AskCookButton() {
  const { session } = useSession()
  return (
    <button type="button" className="icon-btn" aria-label="Ask the cook a question"
      onClick={() => (session ? window.dispatchEvent(new Event(OPEN_EVENT)) : askToSignIn(location.pathname))}>
      <Icon name="chat" />
    </button>
  )
}

// One conversation, for either side. Live when Realtime is connected, with a
// check every 20 seconds as a fallback.
export function ChatThread({ chatId, asSeller, otherName }: { chatId: string; asSeller: boolean; otherName: string }) {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    const { data } = await supabase!.from('shop_chat_messages').select('id, from_seller, body, created_at').eq('chat_id', chatId).order('created_at').limit(300)
    setMessages(data ?? [])
    supabase!.rpc('mark_chat_read', { p_chat: chatId }).then(() => window.dispatchEvent(new Event('chats-read')))
  }, [chatId])

  useEffect(() => {
    load()
    const db = supabase!
    const timer = window.setInterval(load, 20000)
    const channel = db
      .channel(`shop-chat-${chatId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'food', table: 'shop_chat_messages', filter: `chat_id=eq.${chatId}` }, () => load())
      .subscribe()
    return () => {
      window.clearInterval(timer)
      db.removeChannel(channel)
    }
  }, [chatId, load])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' })
  }, [messages?.length])

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!text.trim()) return
    setSending(true)
    setError('')
    const { data: note, error: err } = await supabase!.rpc('send_chat_message', { p_chat: chatId, p_body: text })
    setSending(false)
    if (err) return setError(err.message)
    if (typeof note === 'string' && note) setError(note)
    setText('')
    load()
  }

  return (
    <div className="chat">
      <div className="chat-list tall">
        {messages === null && <p className="muted small">Loading…</p>}
        {messages?.map((m) => (
          <div key={m.id} className={`bubble ${m.from_seller === asSeller ? 'mine' : ''}`}>
            <span className="story">{m.body}</span>
            <span className="tiny">{chatTime(m.created_at)}</span>
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

export const unreadFor = (c: ShopChat, asSeller: boolean) =>
  asSeller ? !c.seller_read_at || c.seller_read_at < c.last_message_at : c.customer_read_at < c.last_message_at
