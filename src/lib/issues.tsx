import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'
import { myUserId } from './session'
import { photoUrl, uploadPhoto } from './images'
import { ImageCropper } from './ImageCropper'
import { Icon } from './icons'
import { pounds } from './types'
import { link } from './router'

// "Problem with my order": the customer tells the cook what went wrong (with
// a photo), the cook can refund in one tap, and BiteBY steps in when needed.

export type IssueReason = 'missing' | 'wrong' | 'quality' | 'late_cold' | 'not_received' | 'allergy' | 'other'
export type IssueStatus = 'open' | 'with_biteby' | 'refunded' | 'resolved'

export type OrderIssue = {
  id: string
  order_id: string
  shop_id: string
  reason: IssueReason
  details: string | null
  photo_path: string | null
  status: IssueStatus
  cook_reply: string | null
  cook_replied_at: string | null
  refund_pence: number
  refunded_by: 'cook' | 'biteby' | null
  biteby_note: string | null
  created_at: string
}

export const ISSUE_REASONS: { key: IssueReason; label: string }[] = [
  { key: 'missing', label: 'Something was missing' },
  { key: 'wrong', label: 'Wrong item' },
  { key: 'quality', label: 'Not as described' },
  { key: 'late_cold', label: 'Late or cold' },
  { key: 'not_received', label: 'Never got it' },
  { key: 'allergy', label: 'Allergy or food safety worry' },
  { key: 'other', label: 'Something else' },
]
export const reasonLabel = (r: IssueReason) => ISSUE_REASONS.find((x) => x.key === r)?.label ?? 'Something else'

export const ISSUE_STATUS: Record<IssueStatus, string> = {
  open: 'Waiting for the cook',
  with_biteby: 'BiteBY is looking into it',
  refunded: 'Refunded',
  resolved: 'Sorted',
}

const shortDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

// What the customer and cook both see: the report, the photo, and replies.
export function IssueThread({ issue }: { issue: OrderIssue }) {
  return (
    <div className="issue-thread">
      <p className="small"><strong>{reasonLabel(issue.reason)}</strong> · <span className="muted">{shortDate(issue.created_at)}</span></p>
      {issue.details && <p className="story small">{issue.details}</p>}
      {issue.photo_path && <img className="review-photo" src={photoUrl(issue.photo_path)!} alt="Photo of the problem" loading="lazy" />}
      {issue.cook_reply && <p className="reply small"><strong>The cook:</strong> {issue.cook_reply}</p>}
      {issue.biteby_note && <p className="reply small"><strong>BiteBY:</strong> {issue.biteby_note}</p>}
      {issue.refund_pence > 0 && (
        <p className="issue-refund small"><Icon name="check" size={16} /> {pounds(issue.refund_pence)} refunded by {issue.refunded_by === 'cook' ? 'the cook' : 'BiteBY'}</p>
      )}
    </div>
  )
}

// On the customer's order page.
export function ProblemSection({ orderId, canReport, deadline }: { orderId: string; canReport: boolean; deadline?: string | null }) {
  const [issue, setIssue] = useState<OrderIssue | null | undefined>(undefined)
  const [open, setOpen] = useState(() => window.location.hash === '#problem')
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    const { data } = await supabase!.from('order_issues').select('*').eq('order_id', orderId).maybeSingle()
    setIssue(data)
  }, [orderId])

  useEffect(() => {
    load()
  }, [load])

  async function act(action: 'sorted' | 'escalate') {
    const { error } = await supabase!.rpc('customer_issue_action', { p_issue: issue!.id, p_action: action })
    if (error) return setMessage(error.message)
    load()
  }

  if (issue === undefined) return null
  if (issue) {
    return (
      <section className="card stack" id="problem" style={{ gap: 8 }}>
        <div className="item">
          <h2 className="h-icon"><Icon name="flag" size={20} /> Problem reported</h2>
          <span className={`pill ${issue.status === 'refunded' || issue.status === 'resolved' ? 'green' : 'yellow'}`}>{ISSUE_STATUS[issue.status]}</span>
        </div>
        <IssueThread issue={issue} />
        {issue.status === 'open' && (
          <>
            <p className="muted small">
              {issue.cook_reply ? 'Not sorted? BiteBY can step in.' : 'The cook has 24 hours to answer. If they don’t, BiteBY steps in automatically.'}
            </p>
            <div className="row">
              <button type="button" className="secondary small-btn" onClick={() => act('sorted')}>It’s sorted</button>
              <button type="button" className="small-btn" onClick={() => act('escalate')}>Ask BiteBY to help</button>
            </div>
          </>
        )}
        {issue.status === 'with_biteby' && <p className="muted small">We’ll reply here and send you an alert.</p>}
        {message && <p className="error small">{message}</p>}
      </section>
    )
  }
  if (!canReport) return null
  return (
    <section className="card" id="problem">
      {!open ? (
        <button type="button" className="row-button" onClick={() => setOpen(true)}>
          <span className="set-icon"><Icon name="flag" size={22} filled /></span>
          <span className="sum-text"><strong>Problem with my order</strong><span className="muted small">Missing, wrong or not right? Tell the cook{deadline ? ` by ${deadline}` : ''}.</span></span>
          <Icon name="chevron" size={18} />
        </button>
      ) : (
        <ReportForm orderId={orderId} onCancel={() => setOpen(false)} onDone={load} />
      )}
    </section>
  )
}

function ReportForm({ orderId, onCancel, onDone }: { orderId: string; onCancel: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<IssueReason | null>(null)
  const [details, setDetails] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function send() {
    if (!reason) return setMessage('Choose what went wrong.')
    setBusy(true)
    setMessage('')
    try {
      const path = photo ? await uploadPhoto(await myUserId(), photo.blob) : null
      const { error } = await supabase!.rpc('report_order_issue', { p_order: orderId, p_reason: reason, p_details: details || null, p_photo: path })
      if (error) throw new Error(error.message)
      onDone()
    } catch (err) {
      setMessage((err as Error).message)
    }
    setBusy(false)
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <h2 className="h-icon"><Icon name="flag" size={20} /> What went wrong?</h2>
      <div className="chips wrap">
        {ISSUE_REASONS.map((r) => (
          <button key={r.key} type="button" className={`chip ${reason === r.key ? 'on' : ''}`} aria-pressed={reason === r.key} onClick={() => setReason(r.key)}>{r.label}</button>
        ))}
      </div>
      {reason === 'allergy' && (
        <p className="founding small">If someone is unwell, call 999 or NHS 111 first. This goes straight to the BiteBY team as well as the cook.</p>
      )}
      <textarea rows={3} maxLength={1000} value={details} onChange={(e) => setDetails(e.target.value)}
        placeholder={reason === 'missing' ? 'Which dish was missing?' : 'Tell the cook what happened'} aria-label="Details" />
      {photo ? (
        <div className="review-photo-pick">
          <img src={photo.url} alt="Your photo" />
          <button type="button" className="link" onClick={() => { URL.revokeObjectURL(photo.url); setPhoto(null) }}>Remove photo</button>
        </div>
      ) : (
        <label className="button secondary photo-add">
          <Icon name="plus" size={16} /> Add a photo
          <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = '' }} />
        </label>
      )}
      {file && (
        <ImageCropper file={file} aspect={4 / 3} width={900} title="Photo of the problem" hint="Show what went wrong."
          onCancel={() => setFile(null)} onDone={(blob) => { setFile(null); setPhoto({ blob, url: URL.createObjectURL(blob) }) }} />
      )}
      <p className="muted small">The cook can refund you straight away. If they don’t answer within 24 hours, BiteBY steps in.</p>
      <div className="row">
        <button type="button" onClick={send} disabled={busy}>{busy ? 'Sending…' : 'Send to the cook'}</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
      </div>
      {message && <p className="error small">{message}</p>}
    </div>
  )
}

// On the cook's order card: answer with a refund or a message.
export function CookIssue({ issue, orderTotal, onChanged }: { issue: OrderIssue; orderTotal: number; onChanged: () => void }) {
  const [reply, setReply] = useState('')
  const [amount, setAmount] = useState('')
  const [part, setPart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const left = orderTotal - issue.refund_pence
  const done = issue.status === 'refunded' || issue.status === 'resolved'

  async function answer(refund: number) {
    setBusy(true)
    const { error } = await supabase!.rpc('cook_answer_issue', { p_issue: issue.id, p_refund_pence: refund, p_reply: reply || null })
    setBusy(false)
    if (error) return setMessage(error.message)
    onChanged()
  }

  return (
    <div className={`issue-box ${done ? 'done' : ''}`}>
      <div className="item">
        <strong className="h-icon small"><Icon name="flag" size={16} /> Problem reported</strong>
        <span className={`pill ${done ? 'green' : 'yellow'}`}>{issue.status === 'open' ? 'Needs your answer' : ISSUE_STATUS[issue.status]}</span>
      </div>
      <IssueThread issue={issue} />
      {(issue.status === 'open' || issue.status === 'with_biteby') && (
        <>
          <textarea rows={2} maxLength={500} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Say sorry or explain (the customer sees this)" aria-label="Your reply" />
          {part ? (
            <div className="row">
              <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Up to ${pounds(left)}`} aria-label="Refund amount in pounds" style={{ maxWidth: 140 }} />
              <button type="button" disabled={busy || !(Number(amount) > 0)} onClick={() => answer(Math.round(Number(amount) * 100))}>Refund £{Number(amount) > 0 ? Number(amount).toFixed(2) : '0.00'}</button>
            </div>
          ) : (
            <div className="row">
              <button type="button" disabled={busy} onClick={() => answer(left)}>Refund all {pounds(left)}</button>
              <button type="button" className="secondary" onClick={() => setPart(true)}>Refund part</button>
            </div>
          )}
          <button type="button" className="secondary small-btn" disabled={busy || !reply.trim()} onClick={() => answer(0)}>Just reply</button>
          <p className="muted tiny">Refunds come out of this order’s payout. BiteBY gives back its fee on the refunded part.</p>
        </>
      )}
      {message && <p className="error small">{message}</p>}
    </div>
  )
}

// Admin: problems that need BiteBY, and a log of recent ones.
type AdminIssue = OrderIssue & { orders: { code: string; total_pence: number; refunded_pence: number; customer_name: string }; shops: { name: string; slug: string } }

export function AdminProblems() {
  const [tab, setTab] = useState<'help' | 'all'>('help')
  const [list, setList] = useState<AdminIssue[] | null>(null)

  const load = useCallback(async () => {
    let q = supabase!.from('order_issues').select('*, orders(code, total_pence, refunded_pence, customer_name), shops(name, slug)').order('created_at', { ascending: false }).limit(100)
    if (tab === 'help') q = q.eq('status', 'with_biteby')
    const { data } = await q
    setList((data ?? []) as AdminIssue[])
  }, [tab])

  useEffect(() => {
    setList(null)
    load()
  }, [load])

  return (
    <div className="stack">
      <div className="segmented">
        <label className={tab === 'help' ? 'on' : ''}><input type="radio" checked={tab === 'help'} onChange={() => setTab('help')} />Needs BiteBY</label>
        <label className={tab === 'all' ? 'on' : ''}><input type="radio" checked={tab === 'all'} onChange={() => setTab('all')} />All recent</label>
      </div>
      {list === null && <p className="muted">Loading…</p>}
      {list?.length === 0 && <p className="muted">{tab === 'help' ? 'Nothing needs you. Nice.' : 'No problems reported yet.'}</p>}
      {list?.map((i) => <AdminIssueCard key={i.id} issue={i} onDone={load} />)}
    </div>
  )
}

function AdminIssueCard({ issue, onDone }: { issue: AdminIssue; onDone: () => void }) {
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const [message, setMessage] = useState('')
  const left = issue.orders.total_pence - issue.orders.refunded_pence

  async function answer(refund: number) {
    const { error } = await supabase!.rpc('admin_answer_issue', { p_issue: issue.id, p_refund_pence: refund, p_note: note || null })
    if (error) return setMessage(error.message)
    onDone()
  }

  return (
    <article className="card stack" style={{ gap: 6 }}>
      <div className="item">
        <strong>Order {issue.orders.code}</strong>
        <span className={`pill ${issue.status === 'with_biteby' ? 'yellow' : issue.status === 'open' ? '' : 'green'}`}>{ISSUE_STATUS[issue.status]}</span>
      </div>
      <p className="muted small">
        {issue.orders.customer_name} · <a href={`/s/${issue.shops.slug}`} onClick={link(`/s/${issue.shops.slug}`)}>{issue.shops.name}</a> · {pounds(issue.orders.total_pence)}
      </p>
      <IssueThread issue={issue} />
      {issue.status === 'with_biteby' && (
        <>
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Message to the customer" aria-label="Message" />
          <div className="row">
            <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={`Up to ${pounds(left)}`} aria-label="Refund in pounds" style={{ maxWidth: 150 }} />
            <button type="button" disabled={!(Number(amount) > 0)} onClick={() => answer(Math.round(Number(amount) * 100))}>Refund</button>
          </div>
          <button type="button" className="secondary small-btn" disabled={!note.trim()} onClick={() => answer(0)}>Reply and close, no refund</button>
        </>
      )}
      {message && <p className="error small">{message}</p>}
    </article>
  )
}
