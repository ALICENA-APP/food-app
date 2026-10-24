import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { useSession } from './session'
import { link } from './router'
import { Icon, type IconName } from './icons'

// For first-time visitors: what BiteBY is and why it's safe. Hidden once
// they've ordered or closed it.

const KEY = 'how-it-works-closed'

const STEPS: { icon: IconName; title: string; text: string }[] = [
  { icon: 'chef', title: 'Find a cook', text: 'Homemade food from people near you.' },
  { icon: 'shield', title: 'Order and pay', text: 'Pay safely in the app. You’re only charged when the cook accepts.' },
  { icon: 'truck', title: 'Get your food', text: 'Collect it or get it delivered. Chat with the cook any time.' },
]

const TRUST: { icon: IconName; filled?: boolean; text: string }[] = [
  { icon: 'check', text: 'Every cook checked' },
  { icon: 'store', filled: true, text: 'Council registered' },
  { icon: 'star', filled: true, text: 'Real reviews only' },
  { icon: 'pound', text: 'Refunds if it goes wrong' },
]

export function HowItWorks() {
  const { session } = useSession()
  const [closed, setClosed] = useState(() => {
    try { return localStorage.getItem(KEY) === '1' } catch { return false }
  })
  const [ordered, setOrdered] = useState(false)

  useEffect(() => {
    if (!session || closed) return
    supabase!.from('orders').select('id').eq('customer_id', session.user.id).limit(1).then(({ data }) => setOrdered(Boolean(data?.length)))
  }, [session, closed])

  if (closed || ordered) return null

  function close() {
    try { localStorage.setItem(KEY, '1') } catch { /* ignore */ }
    setClosed(true)
  }

  return (
    <section className="how-it-works">
      <div className="section-head">
        <h2>How BiteBY works</h2>
        <button type="button" className="link-plain" onClick={close} aria-label="Hide how BiteBY works"><Icon name="close" size={18} /></button>
      </div>
      <ol className="how-steps">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <span className="how-ic"><Icon name={s.icon} size={28} filled /><span className="how-n">{i + 1}</span></span>
            <strong>{s.title}</strong>
            <span className="small muted">{s.text}</span>
          </li>
        ))}
      </ol>
      <ul className="trust-row">
        {TRUST.map((t) => (
          <li key={t.text}><Icon name={t.icon} size={16} filled={t.filled} /> {t.text}</li>
        ))}
      </ul>
      <a className="tiny" href="/help" onClick={link('/help')}>More about staying safe</a>
    </section>
  )
}
