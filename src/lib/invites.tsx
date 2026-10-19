import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { link, queryParam } from './router'
import { share } from './ui'
import { useWelcomeHeadline } from './platform'

type Invited = { name: string; status: string; paid_orders: number; rewarded_at: string | null }
type MyInvites = {
  code: string; can_invite: boolean; free_days: number; orders_needed: number; max_rewards: number
  invited_by: string | null; my_reward_at: string | null; invited: Invited[]
}

const KEY = 'biteby-invite'
const months = (days: number) => (days === 30 ? 'a free month' : `${days} free days`)

// An invite code from a link (/sell?invite=ABC123), kept until the cook has
// started their application and it can be used.
export function savedInviteCode() {
  const fromLink = queryParam('invite').trim().toUpperCase()
  try {
    if (fromLink) localStorage.setItem(KEY, fromLink)
    return fromLink || localStorage.getItem(KEY) || ''
  } catch {
    return fromLink
  }
}
function forgetInviteCode() {
  try { localStorage.removeItem(KEY) } catch { /* private mode */ }
}

// "Invited by Ama's Kitchen" banner for someone who arrived from an invite link.
export function InviteBanner() {
  const [info, setInfo] = useState<{ shop_name: string; free_days: number } | null>(null)
  const offerOpen = Boolean(useWelcomeHeadline())
  useEffect(() => {
    const code = savedInviteCode()
    if (code) supabase?.rpc('invite_info', { p_code: code }).then(({ data }) => setInfo(data ?? null))
  }, [])
  if (!info) return null
  return (
    <div className="card invite-banner">
      <strong>{info.shop_name} invited you</strong>
      <span className="small">Join with their invite and you both get {months(info.free_days)} with no BiteBY fee{offerOpen ? ', on top of your first free month' : ''}, once you’ve had a few orders.</span>
    </div>
  )
}

// Uses a saved invite code once the cook has an application, or lets them type one.
export function UseInviteCode({ onUsed }: { onUsed?: () => void }) {
  const [data, setData] = useState<MyInvites | null>(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')

  async function use(c: string, auto = false) {
    const { data: from, error } = await supabase!.rpc('use_invite_code', { p_code: c })
    if (error) {
      if (auto) forgetInviteCode()
      return setMessage(auto ? '' : error.message)
    }
    forgetInviteCode()
    setMessage(`Invite from ${from} added.`)
    load()
    onUsed?.()
  }
  async function load() {
    const { data: d } = await supabase!.rpc('my_invites')
    setData(d ?? null)
    return d as MyInvites | null
  }
  useEffect(() => {
    load().then((d) => {
      const saved = savedInviteCode()
      if (d && !d.invited_by && saved && saved !== d.code) use(saved, true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!data) return null
  if (data.invited_by) {
    return <p className="small invite-done">Invited by <strong>{data.invited_by}</strong>: you’ll both get {months(data.free_days)} with no BiteBY fee once you’ve had {data.orders_needed} paid orders.{message && ` ${message}`}</p>
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    if (code.trim()) use(code.trim())
  }
  return (
    <details className="card">
      <summary>Have an invite code?</summary>
      <form className="row" onSubmit={submit}>
        <input value={code} maxLength={10} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="e.g. K7M2QX" aria-label="Invite code" autoCapitalize="characters" />
        <button type="submit" className="secondary" disabled={!code.trim()}>Add</button>
      </form>
      {message && <p className="small">{message}</p>}
    </details>
  )
}

// On the cook's dashboard: their invite link and the cooks they've invited.
export function InviteCard() {
  const [data, setData] = useState<MyInvites | null>(null)
  const offerOpen = Boolean(useWelcomeHeadline())
  useEffect(() => {
    supabase!.rpc('my_invites').then(({ data: d }) => setData(d ?? null))
  }, [])
  if (!data || !data.can_invite || !data.free_days || !data.max_rewards) return null
  const url = `${window.location.origin}/sell?invite=${data.code}`
  const earned = data.invited.filter((i) => i.rewarded_at).length
  const left = Math.max(0, data.max_rewards - earned)
  return (
    <details className="card invite-card">
      <summary>
        <span className="invite-sum">
          <strong>Invite a cook, you both get {months(data.free_days)}</strong>
          <span className="muted small">Code {data.code}{earned > 0 && ` · ${earned} earned`}</span>
        </span>
      </summary>
      <div className="details-body">
        <p className="muted small">
          When a cook you invite has {data.orders_needed} paid orders, you both get {data.free_days} days with no BiteBY fee.{offerOpen ? ' They get it on top of their own first free month.' : ''} {left > 0 ? `You can earn ${left} more free ${left === 1 ? 'month' : 'months'} this way.` : 'You’ve earned the most free months invites give: thank you! Your invites still help new cooks.'}
        </p>
        <div className="invite-code">
          <span className="muted tiny">Your invite code</span>
          <strong>{data.code}</strong>
        </div>
        <button type="button" onClick={() => share('Sell your food on BiteBY with my invite', url)}>Share your invite link</button>
        {data.invited.length > 0 && (
          <div className="stack invite-list">
            {data.invited.map((i, n) => (
              <div key={n} className="item">
                <span>{i.name}</span>
                <span className="small">{i.rewarded_at ? 'Free month earned ✓' : i.status !== 'approved' ? 'Getting approved' : `${i.paid_orders} of ${data.orders_needed} orders`}</span>
              </div>
            ))}
          </div>
        )}
        <p className="tiny muted"><a href="/fees" onClick={link('/fees')}>How fees work</a></p>
      </div>
    </details>
  )
}
