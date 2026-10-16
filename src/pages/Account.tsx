import { useState } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { useSession } from '../lib/session'
import { Icon } from '../lib/icons'

// Download a copy of your data, or delete your account.
export default function Account() {
  const { session } = useSession()
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function download() {
    const db = supabase!
    const uid = session!.user.id
    const [profile, addresses, favourites, orders, reviews, messages] = await Promise.all([
      db.from('profiles').select('display_name, phone, marketing_consent, created_at').eq('id', uid).maybeSingle(),
      db.from('addresses').select('label, address, postcode, created_at'),
      db.from('favourites').select('product_id, shop_id, created_at'),
      db.from('orders').select('code, status, fulfilment, requested_for, customer_name, customer_phone, customer_note, delivery_address, delivery_postcode, subtotal_pence, delivery_fee_pence, total_pence, created_at, shops(name), order_items(name, qty, unit_price_pence)').eq('customer_id', uid),
      db.from('reviews').select('rating, comment, created_at, shops(name)').eq('customer_id', uid),
      db.from('order_messages').select('order_id, body, created_at').eq('sender_id', uid),
    ])
    const data = {
      exported_at: new Date().toISOString(),
      account: { email: session!.user.email, created_at: session!.user.created_at },
      profile: profile.data, addresses: addresses.data, saved: favourites.data,
      orders: orders.data, reviews: reviews.data, messages_you_sent: messages.data,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `biteby-my-data-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function remove() {
    setBusy(true)
    setError('')
    const { error: err } = await supabase!.rpc('delete_my_account')
    setBusy(false)
    if (err) return setError(err.message)
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
        <h2>Download your data</h2>
        <p className="muted small">A file with your profile, addresses, orders, reviews, saved items and messages.</p>
        <button type="button" className="secondary" onClick={download}>Download my data</button>
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
