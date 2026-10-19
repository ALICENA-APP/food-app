import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import type { Verification } from './types'

// Food liability insurance: cooks upload their certificate and its expiry
// date. Shops without valid insurance are hidden from customers until a new
// one is uploaded; shops with it get an "Insured" badge.

const DOCS = 'seller-documents'
const MAX_BYTES = 5 * 1024 * 1024

export const ukDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
const todayUK = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' })
const daysUntil = (d: string) => Math.round((Date.parse(d) - Date.parse(todayUK())) / 864e5)

// Shops (from a list) whose cook has valid insurance.
export function useInsured(shopIds: string[]) {
  const [set, setSet] = useState<Set<string>>(new Set())
  const key = [...new Set(shopIds)].sort().join(',')
  useEffect(() => {
    if (!key) return
    supabase!.rpc('shops_insured', { p_shops: key.split(',') }).then(({ data }) => {
      setSet(new Set(((data ?? []) as (string | { shops_insured: string })[]).map((x) => (typeof x === 'string' ? x : x.shops_insured))))
    })
  }, [key])
  return set
}

// Whether BiteBY currently asks cooks for insurance (Admin > Settings).
export function useInsuranceRequired() {
  const [required, setRequired] = useState(true)
  useEffect(() => {
    supabase!.from('platform_settings').select('insurance_required').maybeSingle()
      .then(({ data }) => setRequired(data?.insurance_required ?? true))
  }, [])
  return required
}

// The cook's latest certificate that hasn't been turned down.
export function currentInsurance(rows: Verification[]) {
  return rows
    .filter((v) => v.kind === 'insurance' && v.status !== 'rejected')
    .sort((a, b) => (b.expires_at ?? '').localeCompare(a.expires_at ?? ''))[0]
}
export const insuranceValid = (v?: Verification) => Boolean(v?.expires_at && daysUntil(v.expires_at) >= 0)

export async function openCertificate(path: string) {
  const { data } = await supabase!.storage.from(DOCS).createSignedUrl(path, 300)
  if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener')
}

export function InsuranceHelp() {
  return (
    <p className="muted small">
      You need <strong>public and products liability insurance</strong> for selling food from home. It pays out if someone
      is made ill or hurt by your food, so you and your customers are protected. Many insurers offer cover for home bakers
      and cooks, often from about £5 to £15 a month. Ask for at least £1 million of cover, then upload the certificate here.
    </p>
  )
}

// Upload a certificate: insurer, policy number, expiry date and the file.
export function InsuranceForm({ accountId, onSaved, submitLabel = 'Save' }: { accountId: string; onSaved: () => void; submitLabel?: string }) {
  const [insurer, setInsurer] = useState('')
  const [policy, setPolicy] = useState('')
  const [expires, setExpires] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setMessage('')
    if (!file) return setMessage('Add a photo or PDF of your certificate.')
    if (file.size > MAX_BYTES) return setMessage('That file is over 5 MB. Try a photo or a smaller PDF.')
    setBusy(true)
    const ext = file.type === 'application/pdf' ? 'pdf' : file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg'
    const path = `${accountId}/insurance-${Date.now()}.${ext}`
    const up = await supabase!.storage.from(DOCS).upload(path, file, { contentType: file.type || undefined })
    if (up.error) {
      setBusy(false)
      return setMessage(up.error.message)
    }
    const { error } = await supabase!.from('seller_verifications').insert({
      seller_account_id: accountId, kind: 'insurance', authority: insurer.trim(), reference: policy.trim() || null,
      expires_at: expires, document_path: path,
    })
    setBusy(false)
    if (error) {
      await supabase!.storage.from(DOCS).remove([path])
      return setMessage(error.message)
    }
    setFile(null)
    onSaved()
  }

  return (
    <form className="stack" onSubmit={onSubmit}>
      <label>
        Insurance company
        <input required maxLength={200} value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="e.g. Simply Business" />
      </label>
      <label>
        Policy number (if you have one)
        <input maxLength={100} value={policy} onChange={(e) => setPolicy(e.target.value)} />
      </label>
      <label>
        Date it runs out
        <input required type="date" value={expires} min={todayUK()} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <label>
        Certificate (photo or PDF)
        <input required type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <button type="submit" disabled={busy}>{busy ? 'Uploading…' : submitLabel}</button>
      {message && <p className="error small">{message}</p>}
    </form>
  )
}

// Application step: upload the certificate before sending the application.
export function InsuranceStep({ accountId, rows, editable, step, onSaved }: { accountId: string; rows: Verification[]; editable: boolean; step: number; onSaved: () => void }) {
  const current = currentInsurance(rows)
  const valid = insuranceValid(current)
  return (
    <div className="card">
      <h2>{step}. Food insurance {valid && <span className="tick">✓</span>}</h2>
      <InsuranceHelp />
      {valid && current && <InsuranceSummary v={current} />}
      {editable && !valid && <InsuranceForm accountId={accountId} onSaved={onSaved} />}
    </div>
  )
}

function InsuranceSummary({ v }: { v: Verification }) {
  return (
    <p className="small" style={{ margin: 0 }}>
      {v.authority ?? 'Insurance'}{v.reference && `, policy ${v.reference}`}. Valid until {ukDate(v.expires_at!)}.
      {v.document_path && <> <button type="button" className="link" onClick={() => openCertificate(v.document_path!)}>View certificate</button></>}
    </p>
  )
}

type InsuranceState = { rows: Verification[]; due: string | null; required: boolean }

function useMyInsurance(accountId: string) {
  const [state, setState] = useState<InsuranceState | null>(null)
  const load = useCallback(async () => {
    const db = supabase!
    const [v, a, p] = await Promise.all([
      db.from('seller_verifications').select('*').eq('seller_account_id', accountId).eq('kind', 'insurance'),
      db.from('seller_accounts').select('insurance_due').eq('id', accountId).maybeSingle(),
      db.from('platform_settings').select('insurance_required').maybeSingle(),
    ])
    setState({ rows: (v.data ?? []) as Verification[], due: a.data?.insurance_due ?? null, required: p.data?.insurance_required ?? true })
  }, [accountId])
  useEffect(() => {
    load()
  }, [load])
  return { state, load }
}

function status(s: InsuranceState) {
  const current = currentInsurance(s.rows)
  const left = current?.expires_at ? daysUntil(current.expires_at) : -1
  if (left >= 0) {
    if (left <= 30) return { current, tone: 'warn' as const, line: left === 0 ? 'Runs out today: upload your renewal' : `Runs out in ${left} ${left === 1 ? 'day' : 'days'}: upload your renewal` }
    return { current, tone: 'ok' as const, line: `Insured until ${ukDate(current!.expires_at!)}` }
  }
  if (!s.required) return { current, tone: 'none' as const, line: 'Not added yet' }
  if (s.due && daysUntil(s.due) >= 0) return { current, tone: 'warn' as const, line: `Needed by ${ukDate(s.due)} to keep your shop open` }
  return { current, tone: 'bad' as const, line: current ? 'Ran out: your shop is hidden from customers' : 'Needed: your shop is hidden from customers' }
}

// Black notice at the top of the dashboard when insurance needs doing.
export function InsuranceAlert({ accountId }: { accountId: string }) {
  const { state } = useMyInsurance(accountId)
  if (!state) return null
  const s = status(state)
  if (s.tone === 'ok' || s.tone === 'none') return null
  return (
    <a className="status insurance-alert" href="#insurance" onClick={() => {
      const d = document.getElementById('insurance') as HTMLDetailsElement | null
      if (d) d.open = true
    }}>
      <strong>Food insurance:</strong> {s.line}.
    </a>
  )
}

// Collapsible card on the cook's dashboard.
export function InsuranceCard({ accountId }: { accountId: string }) {
  const { state, load } = useMyInsurance(accountId)
  const [renewing, setRenewing] = useState(false)
  if (!state) return null
  const s = status(state)
  return (
    <details className="card insurance-card" id="insurance" open={s.tone === 'bad' || (s.tone === 'warn' && !s.current) || undefined}>
      <summary>
        <span className="sum-row">
          <span className={`ins-dot ${s.tone}`} aria-hidden="true">
            <svg viewBox="0 0 24 24" width="17" height="17"><path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z" fill="#fff" /><path d="M8.3 12.2l2.6 2.6 4.8-5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
          <span className="sum-text">
            <strong>Food insurance</strong>
            <span className="muted small">{s.line}</span>
          </span>
        </span>
      </summary>
      <div className="details-body">
        <InsuranceHelp />
        {s.current && insuranceValid(s.current) && <InsuranceSummary v={s.current} />}
        {s.tone === 'ok' && <p className="muted small" style={{ margin: 0 }}>Customers see an “Insured” badge on your shop. We’ll remind you 30 and 7 days before it runs out.</p>}
        {s.tone === 'ok' && !renewing
          ? <button type="button" className="secondary" onClick={() => setRenewing(true)}>Upload a new certificate</button>
          : <InsuranceForm accountId={accountId} submitLabel="Upload certificate" onSaved={() => { setRenewing(false); load() }} />}
      </div>
    </details>
  )
}
