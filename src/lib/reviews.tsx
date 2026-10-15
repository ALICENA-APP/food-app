import { useState, type FormEvent } from 'react'
import { supabase } from './supabase'

export type Review = {
  id: string
  order_id: string
  shop_id: string
  reviewer_name: string
  rating: number
  comment: string | null
  seller_reply: string | null
  hidden: boolean
  hidden_reason: string | null
  created_at: string
}

export function Stars({ value, size }: { value: number; size?: 'small' }) {
  const full = Math.round(value)
  return (
    <span className={`stars ${size ?? ''}`} aria-label={`${value} out of 5 stars`}>
      {'★★★★★'.slice(0, full)}
      <span className="off">{'★★★★★'.slice(full)}</span>
    </span>
  )
}

export function ReviewItem({ review, children }: { review: Review; children?: React.ReactNode }) {
  return (
    <div className="review">
      <div className="item">
        <strong>{review.reviewer_name}</strong>
        <Stars value={review.rating} size="small" />
      </div>
      <p className="muted small">{new Date(review.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
      {review.comment && <p className="story">{review.comment}</p>}
      {review.seller_reply && <p className="reply small"><strong>Reply from the cook:</strong> {review.seller_reply}</p>}
      {children}
    </div>
  )
}

// Customer leaves a review on a completed order.
export function ReviewForm({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!rating) return setMessage('Choose 1 to 5 stars.')
    const { error } = await supabase!.rpc('leave_review', { p_order: orderId, p_rating: rating, p_comment: comment || null })
    if (error) return setMessage(error.message)
    onDone()
  }

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>How was it?</h2>
      <div className="star-picker" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} stars`}
            className={n <= rating ? 'on' : ''} onClick={() => setRating(n)}>★</button>
        ))}
      </div>
      <textarea rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell others about the food (optional)" />
      <p className="muted small">Your first name is shown with your review.</p>
      <button type="submit">Post review</button>
      {message && <p className="error">{message}</p>}
    </form>
  )
}
