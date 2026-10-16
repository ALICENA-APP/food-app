import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { AdminOrders, AdminOverview, AdminReviews } from './AdminMore'
import type { SellerAccount, SellerStatus, Shop, Verification } from '../lib/types'

// Admin screen. Needs an admin account and a two-step (authenticator app)
// sign-in; the database checks both on every action.
export default function Admin() {
  const [state, setState] = useState<'loading' | 'not_admin' | 'needs_mfa' | 'ok'>('loading')

  const check = useCallback(async () => {
    const db = supabase!
    const { data: isAdmin } = await db.rpc('am_i_admin')
    if (!isAdmin) return setState('not_admin')
    const { data: aal } = await db.auth.mfa.getAuthenticatorAssuranceLevel()
    setState(aal?.currentLevel === 'aal2' ? 'ok' : 'needs_mfa')
  }, [])

  useEffect(() => {
    check()
  }, [check])

  if (state === 'loading') return <p className="muted">Loading…</p>
  if (state === 'not_admin') return <p className="card">This page is for the BiteBY team.</p>
  if (state === 'needs_mfa') return <TwoStep onDone={check} />
  return <AdminTabs />
}

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'sellers', label: 'Sellers' },
  { key: 'orders', label: 'Orders' },
  { key: 'reviews', label: 'Reviews' },
] as const

function AdminTabs() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('overview')
  return (
    <div className="stack">
      <h1>Admin</h1>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} type="button" className={tab === t.key ? 'on' : ''} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview' && <AdminOverview />}
      {tab === 'sellers' && <Sellers />}
      {tab === 'orders' && <AdminOrders />}
      {tab === 'reviews' && <AdminReviews />}
    </div>
  )
}

function TwoStep({ onDone }: { onDone: () => void }) {
  const [factorId, setFactorId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    ;(async () => {
      const mfa = supabase!.auth.mfa
      const { data } = await mfa.listFactors()
      const verified = data?.totp?.[0]
      if (verified) return setFactorId(verified.id)
      // Clear any half-finished set-up, then start a fresh one.
      for (const f of data?.all ?? []) {
        if (f.status !== 'verified') await mfa.unenroll({ factorId: f.id })
      }
      const { data: enrolled, error } = await mfa.enroll({ factorType: 'totp', friendlyName: 'BiteBY admin' })
      if (error) return setMessage(error.message)
      setFactorId(enrolled.id)
      setQr(enrolled.totp.qr_code)
      setSecret(enrolled.totp.secret)
    })()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase!.auth.mfa.challengeAndVerify({ factorId: factorId!, code: code.trim() })
    if (error) return setMessage('That code did not work. Try the newest one.')
    onDone()
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Two-step sign-in</h2>
      {qr ? (
        <>
          <p className="muted">
            Admin pages need an authenticator app (Google Authenticator, Microsoft Authenticator or
            similar). Scan this code with the app, then type the 6-digit number it shows.
          </p>
          <img src={qr} alt="QR code for your authenticator app" width={200} height={200} className="qr" />
          <p className="muted small">Can't scan? Enter this key in the app: <code>{secret}</code></p>
        </>
      ) : (
        <p className="muted">Type the 6-digit number from your authenticator app.</p>
      )}
      <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" />
      <button type="submit" disabled={!factorId}>Continue</button>
      {message && <p className="error">{message}</p>}
    </form>
  )
}

const ORDER: SellerStatus[] = ['submitted', 'in_review', 'reverification_required', 'draft', 'approved', 'suspended', 'rejected', 'removed']
const LABEL: Record<SellerStatus, string> = {
  submitted: 'Waiting for you',
  in_review: 'Checking',
  reverification_required: 'Changes asked',
  draft: 'Not sent yet',
  approved: 'Approved',
  suspended: 'Suspended',
  rejected: 'Rejected',
  removed: 'Removed',
}
const KIND: Record<Verification['kind'], string> = {
  food_registration: 'Council registration',
  hygiene_rating: 'Hygiene rating',
  allergen_declaration: 'Allergen promise',
  insurance: 'Insurance',
}

type Data = {
  accounts: SellerAccount[]
  verifications: Verification[]
  shops: Shop[]
  emails: Record<string, string>
}

function Sellers() {
  const [data, setData] = useState<Data | null>(null)
  const [filter, setFilter] = useState<'todo' | 'all'>('todo')

  const load = useCallback(async () => {
    const db = supabase!
    const [a, v, s, e] = await Promise.all([
      db.from('seller_accounts').select('*').order('submitted_at', { ascending: true, nullsFirst: false }),
      db.from('seller_verifications').select('*'),
      db.from('shops').select('*'),
      db.rpc('admin_seller_emails'),
    ])
    const emails: Record<string, string> = {}
    for (const row of (e.data ?? []) as { seller_account_id: string; email: string }[]) emails[row.seller_account_id] = row.email
    setData({ accounts: a.data ?? [], verifications: v.data ?? [], shops: s.data ?? [], emails })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (!data) return <p className="muted">Loading…</p>

  const shown = data.accounts
    .filter((a) => filter === 'all' || a.status === 'submitted' || a.status === 'in_review')
    .sort((x, y) => ORDER.indexOf(x.status) - ORDER.indexOf(y.status))

  return (
    <div className="stack">
      <div className="segmented">
        <label className={filter === 'todo' ? 'on not_present' : ''}>
          <input type="radio" checked={filter === 'todo'} onChange={() => setFilter('todo')} />
          To check
        </label>
        <label className={filter === 'all' ? 'on not_present' : ''}>
          <input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} />
          All ({data.accounts.length})
        </label>
      </div>
      {shown.length === 0 && <p className="muted">Nothing waiting.</p>}
      {shown.map((a) => (
        <SellerCard
          key={a.id}
          account={a}
          email={data.emails[a.id]}
          verifications={data.verifications.filter((v) => v.seller_account_id === a.id)}
          shop={data.shops.find((s) => s.seller_account_id === a.id)}
          onChanged={load}
        />
      ))}
    </div>
  )
}

function SellerCard({ account, email, verifications, shop, onChanged }: {
  account: SellerAccount
  email?: string
  verifications: Verification[]
  shop?: Shop
  onChanged: () => void
}) {
  const [note, setNote] = useState('')
  const [message, setMessage] = useState('')

  async function setStatus(status: SellerStatus) {
    const { error } = await supabase!.rpc('admin_set_seller_status', { p_account: account.id, p_status: status, p_note: note || null })
    if (error) return setMessage(error.message)
    setNote('')
    onChanged()
  }

  async function review(id: string, status: Verification['status']) {
    const { error } = await supabase!.rpc('admin_review_verification', { p_id: id, p_status: status })
    if (error) return setMessage(error.message)
    onChanged()
  }

  async function suspendShop() {
    if (!note.trim()) return setMessage('Add a note saying why.')
    const { error } = await supabase!.rpc('admin_set_shop_status', { p_shop: shop!.id, p_status: 'suspended', p_note: note })
    if (error) return setMessage(error.message)
    onChanged()
  }

  return (
    <article className="card">
      <div className="item">
        <strong>{account.legal_name ?? 'No name yet'}</strong>
        <span className="pill">{LABEL[account.status]}</span>
      </div>
      <p className="muted small">
        {[account.trading_name, account.business_type?.replace('_', ' '), email].filter(Boolean).join(' · ')}
      </p>
      {shop && (
        <p className="small">
          Shop: <a href={`/s/${shop.slug}`} onClick={link(`/s/${shop.slug}`)}>{shop.name}</a> ({shop.status})
        </p>
      )}
      <p className="small">Terms: {account.terms_accepted_at ? 'agreed' : 'not agreed'}</p>
      {verifications.map((v) => (
        <div key={v.id} className="check-row">
          <div className="small">
            <strong>{KIND[v.kind]}</strong> · {v.status}
            {v.authority && <><br />{v.authority}{v.reference && `, ref ${v.reference}`}{v.registered_on && `, registered ${v.registered_on}`}</>}
          </div>
          {v.status === 'pending' && (
            <div className="row">
              <button className="secondary small-btn" onClick={() => review(v.id, 'accepted')}>OK</button>
              <button className="secondary small-btn" onClick={() => review(v.id, 'rejected')}>Not OK</button>
            </div>
          )}
        </div>
      ))}
      {account.status_note && <p className="muted small">Last note: {account.status_note}</p>}
      <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the seller (needed unless approving)" />
      <div className="row wrap">
        {account.status !== 'approved' && <button onClick={() => setStatus('approved')}>Approve</button>}
        {account.status !== 'reverification_required' && <button className="secondary" onClick={() => setStatus('reverification_required')}>Ask for changes</button>}
        {account.status !== 'rejected' && account.status !== 'approved' && <button className="secondary" onClick={() => setStatus('rejected')}>Reject</button>}
        {account.status === 'approved' && <button className="secondary" onClick={() => setStatus('suspended')}>Suspend seller</button>}
        {shop && shop.status !== 'suspended' && <button className="secondary" onClick={suspendShop}>Suspend shop</button>}
      </div>
      {message && <p className="error">{message}</p>}
    </article>
  )
}
