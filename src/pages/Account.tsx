import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { useSession } from '../lib/session'
import { Icon } from '../lib/icons'
import { deletePhoto } from '../lib/images'
import { downloadCsv, money } from '../lib/csv'

// Download a copy of your data, or delete your account.
export default function Account() {
  const { session } = useSession()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Everything we hold about you, as one spreadsheet with a section for each kind.
  async function download() {
    const db = supabase!
    const uid = session!.user.id
    const [profile, addresses, favourites, orders, reviews, messages] = await Promise.all([
      db.from('profiles').select('display_name, phone, marketing_consent, created_at').eq('id', uid).maybeSingle(),
      db.from('addresses').select('label, address, postcode, created_at').eq('user_id', uid),
      db.from('favourites').select('created_at, products(name), shops(name)').eq('user_id', uid),
      db.from('orders').select('code, created_at, status, fulfilment, requested_for, customer_name, customer_phone, customer_note, delivery_address, delivery_postcode, subtotal_pence, discount_pence, delivery_fee_pence, total_pence, shops(name), order_items(name, qty)').eq('customer_id', uid).order('created_at'),
      db.from('reviews').select('rating, comment, created_at, shops(name)').eq('customer_id', uid),
      db.from('order_messages').select('body, created_at, orders(code)').eq('sender_id', uid),
    ])
    type Named = { name: string } | null
    const date = (s: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : '')
    const rows: (string | number | null)[][] = [
      ['BiteBY: your data', new Date().toISOString().slice(0, 10)], [],
      ['YOUR DETAILS'], ['Email', session!.user.email ?? ''], ['Name', profile.data?.display_name ?? ''], ['Phone', profile.data?.phone ?? ''],
      ['Marketing emails', profile.data?.marketing_consent ? 'Yes' : 'No'], ['Joined', date(session!.user.created_at)], [],
      ['ADDRESSES'], ['Label', 'Address', 'Postcode', 'Added'],
      ...(addresses.data ?? []).map((a) => [a.label, a.address, a.postcode, date(a.created_at)]), [],
      ['ORDERS'], ['Date', 'Order', 'Cook', 'Items', 'Status', 'How', 'Food (£)', 'Discount (£)', 'Delivery (£)', 'Total (£)', 'Delivery address', 'Note'],
      ...((orders.data ?? []) as unknown as { code: string; created_at: string; status: string; fulfilment: string; subtotal_pence: number; discount_pence: number; delivery_fee_pence: number; total_pence: number; delivery_address: string | null; delivery_postcode: string | null; customer_note: string | null; shops: Named; order_items: { name: string; qty: number }[] }[])
        .map((o) => [date(o.created_at), o.code, o.shops?.name ?? '', o.order_items.map((i) => `${i.qty} x ${i.name}`).join('; '), o.status, o.fulfilment,
          money(o.subtotal_pence), money(o.discount_pence), money(o.delivery_fee_pence), money(o.total_pence),
          [o.delivery_address, o.delivery_postcode].filter(Boolean).join(', '), o.customer_note]), [],
      ['REVIEWS'], ['Date', 'Cook', 'Stars', 'Comment'],
      ...((reviews.data ?? []) as unknown as { rating: number; comment: string | null; created_at: string; shops: Named }[]).map((r) => [date(r.created_at), r.shops?.name ?? '', r.rating, r.comment]), [],
      ['SAVED'], ['Dish', 'Cook', 'Saved'],
      ...((favourites.data ?? []) as unknown as { created_at: string; products: Named; shops: Named }[]).map((f) => [f.products?.name ?? '', f.shops?.name ?? '', date(f.created_at)]), [],
      ['MESSAGES YOU SENT'], ['Date', 'Order', 'Message'],
      ...((messages.data ?? []) as unknown as { body: string; created_at: string; orders: { code: string } | null }[]).map((m) => [date(m.created_at), m.orders?.code ?? '', m.body]),
    ]
    downloadCsv(`biteby-my-data-${new Date().toISOString().slice(0, 10)}.csv`, rows)
  }

  async function remove() {
    setBusy(true)
    setError('')
    const { data: me } = await supabase!.from('profiles').select('avatar_path').eq('id', session!.user.id).maybeSingle()
    const { error: err } = await supabase!.rpc('delete_my_account')
    setBusy(false)
    if (err) return setError(err.message)
    if (me?.avatar_path) await deletePhoto(me.avatar_path)
    try {
      localStorage.removeItem('checkoutDraft')
      localStorage.removeItem('myPostcode')
      localStorage.removeItem('basket')
    } catch {
      // storage unavailable
    }
    await supabase!.auth.signOut()
    window.alert('Your account has been deleted. Thank you for using BiteBY.')
    navigate('/')
  }

  return (
    <div className="stack">
      <a className="back" href="/profile" onClick={link('/profile')}><Icon name="back" size={18} /> Profile</a>
      <h1>Your data</h1>
      <div className="card">
        <h2>Your orders by month</h2>
        <p className="muted small">A statement of what you ordered and paid each month. Save it as a PDF or open it in a spreadsheet.</p>
        <a className="button secondary" href="/account/statement" onClick={link('/account/statement')}>See monthly statements</a>
      </div>
      <div className="card">
        <h2>Download your data</h2>
        <p className="muted small">A spreadsheet with your details, addresses, orders, reviews, saved items and messages. Opens in Excel, Numbers or Google Sheets.</p>
        <button type="button" className="secondary" onClick={download}>Download my data (spreadsheet)</button>
      </div>
      <div className="card">
        <h2>Delete your account</h2>
        <p className="muted small">
          This removes your name, phone, addresses, saved items, messages and alerts, and signs you out. Past orders are
          kept without your details, as the law requires for our accounts. Reviews stay, shown as "Former customer".
          This can't be undone.
        </p>
        {!confirming ? (
          <button type="button" className="secondary danger" onClick={() => setConfirming(true)}>Delete my account</button>
        ) : (
          <>
            <label>
              Type DELETE to confirm
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" />
            </label>
            <div className="row">
              <button type="button" className="danger-solid" disabled={typed.trim().toUpperCase() !== 'DELETE' || busy} onClick={remove}>
                {busy ? 'Deleting…' : 'Delete for good'}
              </button>
              <button type="button" className="secondary" onClick={() => { setConfirming(false); setTyped('') }}>Cancel</button>
            </div>
          </>
        )}
        {error && <p className="error small">{error}</p>}
      </div>
      <p className="muted small">See our <a href="/privacy" onClick={link('/privacy')}>privacy notice</a> for how we use your data.</p>
    </div>
  )
}
