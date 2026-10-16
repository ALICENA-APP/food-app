import { useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { askToSignIn, useSession } from './session'
import { Icon } from './icons'

const REASONS = [
  { key: 'off_app', label: 'They asked me to pay or order outside BiteBY' },
  { key: 'unsafe', label: 'I’m worried the food isn’t safe' },
  { key: 'allergens', label: 'The allergen information looks wrong' },
  { key: 'offensive', label: 'Offensive, or not allowed on BiteBY' },
  { key: 'fake', label: 'Fake or misleading' },
  { key: 'other', label: 'Something else' },
] as const

// A quiet "Report" link that opens a short form. Reports go to the BiteBY
// team's Safety list; the cook isn't told who sent them.
export function ReportLink({ shopId, productId }: { shopId: string; productId?: string }) {
  const { session } = useSession()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const what = productId ? 'dish' : 'shop'

  if (sent) return <p className="card tick small">Thanks. The BiteBY team will look into it. The cook isn’t told who reported.</p>
  if (!open) {
    return (
      <button type="button" className="tile report-tile" onClick={() => (session ? setOpen(true) : askToSignIn(location.pathname))}>
        <span className="ic"><Icon name="flag" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>Report this {what}</span>
          <span className="s">Something not right? Tell the BiteBY team.</span>
        </span>
      </button>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!reason) return setError('Choose a reason.')
    setBusy(true)
    setError('')
    const { error: err } = await supabase!.rpc('report_listing', { p_shop: shopId, p_product: productId ?? null, p_reason: reason, p_details: details.trim() || null })
    setBusy(false)
    if (err) return setError(err.message)
    setSent(true)
  }

  return (
    <form className="card stack" onSubmit={submit}>
      <strong>Report this {what}</strong>
      <div className="stack" style={{ gap: 6 }}>
        {REASONS.map((r) => (
          <label key={r.key} className="check"><input type="radio" name="report-reason" checked={reason === r.key} onChange={() => setReason(r.key)} /> {r.label}</label>
        ))}
      </div>
      {reason === 'unsafe' && <p className="status small">If someone is ill after eating, call NHS 111, or 999 in an emergency.</p>}
      <label>
        Anything else we should know? (optional)
        <textarea rows={3} maxLength={300} value={details} onChange={(e) => setDetails(e.target.value)} />
      </label>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send report'}</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  )
}
