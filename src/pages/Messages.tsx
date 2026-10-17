import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link, navigate, queryParam } from '../lib/router'
import { Icon } from '../lib/icons'
import { ChatThread, chatTime, unreadFor, type ShopChat } from '../lib/askCook'

// Questions to cooks before ordering. Customers see theirs at /messages;
// cooks see questions to their shop at /sell/questions.
export default function Messages({ asSeller, chatId }: { asSeller: boolean; chatId?: string }) {
  const [chats, setChats] = useState<ShopChat[] | null>(null)
  const openId = chatId ?? queryParam('chat')
  const base = asSeller ? '/sell/questions' : '/messages'

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      let q = db.from('shop_chats').select('*, shops(name, slug), products(name)').order('last_message_at', { ascending: false }).limit(100)
      if (asSeller) {
        const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
        const { data: shops } = await db.from('shops').select('id').eq('seller_account_id', account?.id ?? '00000000-0000-0000-0000-000000000000')
        q = q.in('shop_id', (shops ?? []).map((s) => s.id))
      } else {
        q = q.eq('customer_id', await myUserId())
      }
      const { data } = await q
      setChats((data ?? []) as ShopChat[])
    })()
  }, [asSeller, openId])

  const open = chats?.find((c) => c.id === openId)
  if (openId) {
    if (!chats) return <p className="muted">Loading…</p>
    if (!open) return <p className="muted">This conversation isn’t available.</p>
    const other = asSeller ? open.customer_name : open.shops?.name ?? 'the cook'
    return (
      <div className="stack">
        <a className="back" href={base} onClick={link(base)}><Icon name="back" size={18} /> {asSeller ? 'Questions' : 'Messages'}</a>
        <div>
          <h1 style={{ marginBottom: 2 }}>{other}</h1>
          {open.products?.name && <p className="muted small">About {open.products.name}</p>}
          {!asSeller && open.shops && <a className="small" href={`/s/${open.shops.slug}`} onClick={link(`/s/${open.shops.slug}`)}>See the shop</a>}
        </div>
        <ChatThread chatId={open.id} asSeller={asSeller} otherName={other} />
        <p className="muted tiny">{asSeller
          ? 'Answer honestly, especially about allergens. Never share your address or take payment outside BiteBY.'
          : 'Only pay through BiteBY. If a cook asks you to pay another way, tap Help and tell us.'}</p>
      </div>
    )
  }

  return (
    <div className="stack">
      <a className="back" href={asSeller ? '/sell' : '/profile'} onClick={link(asSeller ? '/sell' : '/profile')}><Icon name="back" size={18} /> {asSeller ? 'Your shop' : 'Profile'}</a>
      <h1>{asSeller ? 'Questions' : 'Messages'}</h1>
      <p className="muted">{asSeller ? 'Questions from customers before they order. Quick answers win orders.' : 'Questions you’ve asked cooks before ordering. Messages about an order are on the order itself.'}</p>
      {!chats && <p className="muted">Loading…</p>}
      {chats?.length === 0 && (
        <div className="card empty">
          <span className="big">💬</span>
          <p>{asSeller ? 'No questions yet. Customers can ask from your shop and dish pages.' : 'No messages yet. Tap “Ask the cook” on any dish to ask about allergies, ingredients or timing.'}</p>
        </div>
      )}
      {chats?.map((c) => {
        const unread = unreadFor(c, asSeller)
        return (
          <a key={c.id} className={`card chat-row ${unread ? 'unread' : ''}`} href={`${base}${asSeller ? '?chat=' : '/'}${c.id}`}
            onClick={(e) => { e.preventDefault(); navigate(`${base}${asSeller ? '?chat=' : '/'}${c.id}`) }}>
            <span className="ic"><Icon name="chat" /></span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <strong>{asSeller ? c.customer_name : c.shops?.name}</strong>
              {c.products?.name && <span className="muted small"> · {c.products.name}</span>}
              <span className="muted tiny" style={{ display: 'block' }}>{chatTime(c.last_message_at)}</span>
            </span>
            {unread && <span className="dot" aria-label="Unread" />}
          </a>
        )
      })}
    </div>
  )
}
