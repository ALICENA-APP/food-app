import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { link } from '../lib/router'
import { pounds, TERMS_VERSION, type SellerAccount, type Shop, type Verification } from '../lib/types'
import { Icon, type IconName } from '../lib/icons'
import { Avatar, share } from '../lib/ui'
import { loadRatings, type Rating } from '../lib/catalogue'

const STATUS_TEXT: Record<SellerAccount['status'], string> = {
  draft: 'Not sent yet',
  submitted: 'Sent. We will check your details and get back to you.',
  in_review: 'We are checking your details.',
  approved: 'Approved',
  rejected: 'Not approved',
  reverification_required: 'Please update your details and send them again.',
  suspended: 'Paused by the BiteBY team',
  removed: 'Closed',
}

// The seller's starting point: application steps, then links to shop and menu.
export default function SellerHome() {
  const [account, setAccount] = useState<SellerAccount | null>(null)
  const [verifications, setVerifications] = useState<Verification[]>([])
  const [shop, setShop] = useState<Shop | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const db = supabase!
    const { data: acc, error: accErr } = await db.from('seller_accounts').select('*').maybeSingle()
    if (accErr) return setError(accErr.message)
    setAccount(acc)
    if (acc) {
      const [{ data: ver }, { data: shops }] = await Promise.all([
        db.from('seller_verifications').select('*').eq('seller_account_id', acc.id),
        db.from('shops').select('*').eq('seller_account_id', acc.id).limit(1),
      ])
      setVerifications(ver ?? [])
      setShop(shops?.[0] ?? null)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  if (loading) return <p className="muted">{error || 'Loading…'}</p>

  const editable = !account || account.status === 'draft' || account.status === 'reverification_required'
  const registration = verifications.find((v) => v.kind === 'food_registration' && v.status !== 'rejected')
  const declaration = verifications.find((v) => v.kind === 'allergen_declaration' && v.status !== 'rejected')

  const steps = account && (
    <>
      <FoodRegistration accountId={account.id} current={registration} editable={editable} onSaved={load} />
      <AllergenDeclaration accountId={account.id} done={Boolean(declaration)} editable={editable} onSaved={load} />
      <Terms account={account} editable={editable} onSaved={load} />
      {editable && <Submit ready={Boolean(account.legal_name && registration && declaration && account.terms_accepted_at)} onSaved={load} />}
    </>
  )

  return (
    <div className="stack">
      <h1>{shop ? 'Your shop' : 'Sell on BiteBY'}</h1>
      {!account && (
        <p className="lead">Open your own food shop with a link you can share. Start with a few details about you: it takes about 10 minutes.</p>
      )}
      {account && (
        <p className={`status status-${account.status}`}>
          Application: {STATUS_TEXT[account.status]}
          {account.status_note && <><br />{account.status_note}</>}
        </p>
      )}

      {shop && <Dashboard shop={shop} account={account!} onChanged={load} />}

      {account && !shop && (
        <div className="card">
          <h2>Your shop</h2>
          <p className="muted">You can set up your shop and menu while we check your details. It goes live once you are approved and payments are set up.</p>
          <a className="button" href="/sell/shop" onClick={link('/sell/shop')}>Set up shop</a>
        </div>
      )}

      {account?.status === 'approved' ? (
        <details className="card">
          <summary>Your application details</summary>
          <BusinessDetails account={account} editable={false} onSaved={load} />
          {steps}
        </details>
      ) : (
        <>
          {account && <h2>Your application</h2>}
          <BusinessDetails account={account} editable={editable} onSaved={load} />
          {steps}
        </>
      )}
    </div>
  )
}

function Dashboard({ shop, account, onChanged }: { shop: Shop; account: SellerAccount; onChanged: () => void }) {
  const [stats, setStats] = useState<{ todo: number; today: number; rating: Rating | undefined } | null>(null)
  const [accepting, setAccepting] = useState(shop.accepting_orders)
  const [error, setError] = useState('')
  const url = `${window.location.origin}/s/${shop.slug}`

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const [todo, today, ratings] = await Promise.all([
        db.from('orders').select('id', { count: 'exact', head: true }).eq('shop_id', shop.id).in('status', ['pending_acceptance', 'accepted', 'ready', 'out_for_delivery']),
        db.from('orders').select('subtotal_pence, platform_fee_pence, delivery_fee_pence').eq('shop_id', shop.id).gte('created_at', since.toISOString())
          .not('status', 'in', '(awaiting_payment,declined,cancelled,expired,refunded)'),
        loadRatings([shop.id]),
      ])
      setStats({
        todo: todo.count ?? 0,
        today: (today.data ?? []).reduce((n, o) => n + o.subtotal_pence - o.platform_fee_pence + o.delivery_fee_pence, 0),
        rating: ratings[shop.id],
      })
    })()
  }, [shop.id])

  async function toggle() {
    setError('')
    const next = !accepting
    setAccepting(next)
    const { error: err } = await supabase!.from('shops').update({ accepting_orders: next }).eq('id', shop.id)
    if (err) {
      setAccepting(!next)
      setError(err.message)
    } else onChanged()
  }

  const live = shop.status === 'live'
  return (
    <>
      <div className="card">
        <div className="row-bar" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <Avatar name={shop.name} path={shop.logo_path} size={56} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{shop.name}</strong>
            <span className="muted small" style={{ display: 'block' }}>
              {live ? 'Live' : account.status === 'approved' ? 'Ready to go live once payments are set up' : 'Not live yet'}
            </span>
          </span>
          <a className="button secondary small-btn" href={`/s/${shop.slug}`} onClick={link(`/s/${shop.slug}`)}>View</a>
        </div>
        <label className="switch-row">
          <span>
            <strong>{accepting ? 'Taking orders' : 'Orders paused'}</strong>
            <span className="muted small" style={{ display: 'block' }}>
              {accepting ? 'Customers can order from you now.' : 'Customers can see your menu but can’t order.'}
            </span>
          </span>
          <input type="checkbox" className="switch" checked={accepting} onChange={toggle} aria-label="Taking orders" />
        </label>
        {error && <p className="error small">{error}</p>}
        <div className="row">
          <button type="button" className="secondary small-btn" onClick={() => share(shop.name, url)}><Icon name="share" size={16} /> Share your shop link</button>
        </div>
      </div>

      <div className="stats">
        <a href="/sell/orders" onClick={link('/sell/orders')}><strong>{stats?.todo ?? '–'}</strong><span className="muted tiny">Orders to do</span></a>
        <a href="/sell/earnings" onClick={link('/sell/earnings')}><strong>{stats ? pounds(stats.today) : '–'}</strong><span className="muted tiny">Earned today</span></a>
        <a href="/sell/reviews" onClick={link('/sell/reviews')}><strong>{stats?.rating ? stats.rating.average.toFixed(1) : '–'}</strong><span className="muted tiny">{stats?.rating ? `${stats.rating.reviews} ${stats.rating.reviews === 1 ? 'review' : 'reviews'}` : 'No reviews yet'}</span></a>
      </div>

      <div className="menu-tiles">
        <SellerTile to="/sell/orders" icon="orders" title="Orders" sub="Accept and update" tone="var(--green-soft)" />
        <SellerTile to="/sell/products" icon="chef" title="Menu" sub="Dishes, photos, sold out" />
        <SellerTile to="/sell/shop" icon="store" title="Shop details" sub="Photos, hours, delivery" tone="var(--line)" />
        <SellerTile to="/sell/earnings" icon="pound" title="Earnings" sub="What you've made" tone="var(--line)" />
        <SellerTile to="/sell/reviews" icon="star" title="Reviews" sub="Read and reply" tone="var(--line)" />
        <SellerTile to="/help" icon="help" title="Help" sub="How selling works" tone="var(--line)" />
      </div>
    </>
  )
}

function SellerTile({ to, icon, title, sub, tone = 'var(--yellow-soft)' }: { to: string; icon: IconName; title: string; sub: string; tone?: string }) {
  return (
    <a className="tile" href={to} onClick={link(to)}>
      <span className="ic" style={{ background: tone }}><Icon name={icon} /></span>
      <span style={{ minWidth: 0 }}>
        <span className="t" style={{ display: 'block' }}>{title}</span>
        <span className="s">{sub}</span>
      </span>
    </a>
  )
}

function BusinessDetails({ account, editable, onSaved }: { account: SellerAccount | null; editable: boolean; onSaved: () => void }) {
  const [legalName, setLegalName] = useState(account?.legal_name ?? '')
  const [tradingName, setTradingName] = useState(account?.trading_name ?? '')
  const [businessType, setBusinessType] = useState(account?.business_type ?? 'sole_trader')
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const values = { legal_name: legalName.trim(), trading_name: tradingName.trim() || null, business_type: businessType }
    const { error } = account
      ? await supabase!.from('seller_accounts').update(values).eq('id', account.id)
      : await supabase!.from('seller_accounts').insert(values)
    setMessage(error ? error.message : 'Saved')
    if (!error) onSaved()
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>1. About you</h2>
      <label>
        Your full legal name, or your company name
        <input required maxLength={200} value={legalName} disabled={!editable} onChange={(e) => setLegalName(e.target.value)} />
      </label>
      <label>
        Trading name (optional)
        <input maxLength={200} value={tradingName} disabled={!editable} onChange={(e) => setTradingName(e.target.value)} />
      </label>
      <label>
        Business type
        <select value={businessType} disabled={!editable} onChange={(e) => setBusinessType(e.target.value)}>
          <option value="sole_trader">Sole trader</option>
          <option value="limited_company">Limited company</option>
          <option value="partnership">Partnership</option>
          <option value="other">Other</option>
        </select>
      </label>
      {editable && <button type="submit">Save</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  )
}

function FoodRegistration({ accountId, current, editable, onSaved }: { accountId: string; current?: Verification; editable: boolean; onSaved: () => void }) {
  const [authority, setAuthority] = useState(current?.authority ?? '')
  const [reference, setReference] = useState(current?.reference ?? '')
  const [registeredOn, setRegisteredOn] = useState(current?.registered_on ?? '')
  const [message, setMessage] = useState('')
  const canEdit = editable && (!current || current.status === 'pending')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const values = { authority: authority.trim(), reference: reference.trim() || null, registered_on: registeredOn || null }
    const { error } = current
      ? await supabase!.from('seller_verifications').update(values).eq('id', current.id)
      : await supabase!.from('seller_verifications').insert({ ...values, seller_account_id: accountId, kind: 'food_registration' })
    setMessage(error ? error.message : 'Saved')
    if (!error) onSaved()
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>2. Food business registration {current && <span className="tick">✓</span>}</h2>
      <p className="muted">
        Anyone selling food from home must register with their local council, for free, at least 28
        days before selling. Tell us which council you registered with.
      </p>
      <label>
        Council
        <input required maxLength={200} placeholder="e.g. Tower Hamlets" value={authority} disabled={!canEdit} onChange={(e) => setAuthority(e.target.value)} />
      </label>
      <label>
        Registration reference (if you have one)
        <input maxLength={100} value={reference} disabled={!canEdit} onChange={(e) => setReference(e.target.value)} />
      </label>
      <label>
        Date registered
        <input type="date" value={registeredOn} disabled={!canEdit} onChange={(e) => setRegisteredOn(e.target.value)} />
      </label>
      {canEdit && <button type="submit">Save</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  )
}

function AllergenDeclaration({ accountId, done, editable, onSaved }: { accountId: string; done: boolean; editable: boolean; onSaved: () => void }) {
  const [agreed, setAgreed] = useState(done)
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase!.from('seller_verifications').insert({
      seller_account_id: accountId,
      kind: 'allergen_declaration',
      notes: 'Seller confirmed they will declare all 14 allergens accurately for every item.',
    })
    setMessage(error ? error.message : 'Saved')
    if (!error) onSaved()
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>3. Allergen promise {done && <span className="tick">✓</span>}</h2>
      <label className="check">
        <input type="checkbox" checked={agreed} disabled={done || !editable} onChange={(e) => setAgreed(e.target.checked)} />
        I will list all 14 allergens accurately for every item I sell, and update them whenever a
        recipe or ingredient changes.
      </label>
      {!done && editable && <button type="submit" disabled={!agreed}>Confirm</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  )
}

function Terms({ account, editable, onSaved }: { account: SellerAccount; editable: boolean; onSaved: () => void }) {
  const [agreed, setAgreed] = useState(Boolean(account.terms_accepted_at))
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase!
      .from('seller_accounts')
      .update({ terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
      .eq('id', account.id)
    setMessage(error ? error.message : 'Saved')
    if (!error) onSaved()
  }

  const done = Boolean(account.terms_accepted_at)
  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>4. Seller terms {done && <span className="tick">✓</span>}</h2>
      <ul className="muted small">
        <li>No monthly fee. BiteBY keeps 5% of the food price of each order. Delivery fees are all yours.</li>
        <li>Customers pay up front. You accept or decline each order.</li>
        <li>Your home address is never shown publicly.</li>
        <li>You are responsible for food safety and accurate allergen information.</li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={agreed} disabled={done || !editable} onChange={(e) => setAgreed(e.target.checked)} />
        <span>I agree to the <a href="/seller-terms" onClick={link('/seller-terms')}>seller terms</a>.</span>
      </label>
      {!done && editable && <button type="submit" disabled={!agreed}>Agree</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  )
}

function Submit({ ready, onSaved }: { ready: boolean; onSaved: () => void }) {
  const [message, setMessage] = useState('')

  async function onClick() {
    const { error } = await supabase!.rpc('submit_seller_application')
    setMessage(error ? error.message : '')
    if (!error) onSaved()
  }

  return (
    <div className="card">
      <h2>5. Send for checking</h2>
      <p className="muted">
        {ready ? 'All done. Send your details and we will check them.' : 'Finish steps 1 to 4 first.'}
      </p>
      <button disabled={!ready} onClick={onClick}>
        Send my application
      </button>
      {message && <p className="error">{message}</p>}
    </div>
  )
}
