import { Icon } from '../lib/icons'

// The customer's saved cards. A preview until card payments are switched on:
// Stripe will keep the cards, BiteBY never sees the full number.
const EXAMPLES = [
  { brand: 'Visa', last4: '4242', expires: '08/28', main: true },
  { brand: 'Apple Pay', last4: '', expires: '', main: false },
]

export default function PaymentMethods() {
  return (
    <div className="stack">
      <h1>Payment methods</h1>
      <p className="status small">Preview: card payments aren’t switched on yet, so these are examples.</p>
      <div className="card payout-list">
        {EXAMPLES.map((c) => (
          <div key={c.brand} className="payout-row">
            <span className="sum-row">
              <span className="set-icon"><Icon name="card" size={22} /></span>
              <span className="sum-text">
                <strong>{c.last4 ? `${c.brand} ending ${c.last4}` : c.brand}</strong>
                <span className="muted tiny">{c.expires ? `Expires ${c.expires}` : 'On this phone'}</span>
              </span>
            </span>
            <span className="payout-right">
              {c.main && <span className="payout-tag coming">Main card</span>}
              <button type="button" className="secondary small-btn" disabled>Remove</button>
            </span>
          </div>
        ))}
      </div>
      <button type="button" disabled>Add a card (when payments go live)</button>
      <div className="card info-grey">
        <strong>How paying works</strong>
        <p className="muted small" style={{ margin: 0 }}>You pay by card, Apple Pay or Google Pay when you order. There’s no wallet or balance to top up. Your card is only charged when the cook accepts your order, and refunds go straight back to the same card.</p>
        <p className="muted small" style={{ margin: 0 }}>Cards are kept safely by Stripe, the payment company BiteBY uses. BiteBY never sees or stores your full card number.</p>
      </div>
    </div>
  )
}
