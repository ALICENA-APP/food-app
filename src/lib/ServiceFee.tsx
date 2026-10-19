import { useState } from 'react'
import { Icon } from './icons'
import { pounds } from './types'

// The "Service fee ⓘ" line in an order summary. Tapping ⓘ says what it's for.
export function ServiceFeeRow({ pence }: { pence: number }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="item">
        <span className="fee-label">
          Service fee
          <button type="button" className="info-btn" aria-label="What is the service fee?" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="info" size={16} />
          </button>
        </span>
        <span>{pounds(pence)}</span>
      </div>
      {open && (
        <p className="muted small fee-info">
          Covers secure card payment and your money-back guarantee if the cook can’t make your order. It’s the same however you pay,
          and the cook gets their full price.
        </p>
      )}
    </>
  )
}
