import { useState, type FormEvent } from 'react'
import { supabase } from './supabase'
import { ImageCropper } from './ImageCropper'
import { photoUrl, uploadPhoto } from './images'
import { Icon } from './icons'
import { myUserId } from './session'

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
  photo_path?: string | null
  loved_products?: string[]
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

export function ReviewItem({ review, children, dishNames }: { review: Review; children?: React.ReactNode; dishNames?: Record<string, string> }) {
  return (
    <div className="review">
      <div className="item">
        <strong>{review.reviewer_name}</strong>
        <Stars value={review.rating} size="small" />
      </div>
      <p className="muted small">{new Date(review.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
      {review.comment && <p className="story">{review.comment}</p>}
      {review.photo_path && <img className="review-photo" src={photoUrl(review.photo_path)!} alt={`Photo from ${review.reviewer_name}`} loading="lazy" />}
      {dishNames && (review.loved_products ?? []).some((id) => dishNames[id]) && (
        <p className="small loved"><Icon name="heart" size={14} /> Loved: {(review.loved_products ?? []).map((id) => dishNames[id]).filter(Boolean).join(', ')}</p>
      )}
      {review.seller_reply && <p className="reply small"><strong>Reply from the cook:</strong> {review.seller_reply}</p>}
      {children}
    </div>
  )
}

// Customer leaves a review on a completed order, with an optional photo and
// the dishes they loved.
export function ReviewForm({ orderId, items, onDone }: {
  orderId: string; items: { product_id: string | null; name: string }[]; onDone: () => void
}) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [loved, setLoved] = useState<string[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // One chip per dish, even if it was ordered in two sizes.
  const dishes = [...new Map(items.filter((i) => i.product_id).map((i) => [i.product_id!, i.name.split(' (')[0]])).entries()]

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!rating) return setMessage('Choose 1 to 5 stars.')
    setBusy(true)
    setMessage('')
    try {
      const path = photo ? await uploadPhoto(await myUserId(), photo.blob) : null
      const { error } = await supabase!.rpc('leave_review', { p_order: orderId, p_rating: rating, p_comment: comment || null, p_photo: path, p_loved: loved })
      if (error) throw new Error(error.message)
      onDone()
    } catch (err) {
      setMessage((err as Error).message)
    }
    setBusy(false)
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
      {dishes.length > 0 && (
        <>
          <p className="small"><strong>Which dishes did you love?</strong> (optional)</p>
          <div className="chips wrap">
            {dishes.map(([id, name]) => (
              <button key={id} type="button" className={`chip ${loved.includes(id) ? 'on' : ''}`} aria-pressed={loved.includes(id)}
                onClick={() => setLoved(loved.includes(id) ? loved.filter((x) => x !== id) : [...loved, id])}>
                <Icon name="heart" size={14} /> {name}
              </button>
            ))}
          </div>
        </>
      )}
      <textarea rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Tell others about the food (optional)" />
      {photo ? (
        <div className="review-photo-pick">
          <img src={photo.url} alt="Your photo" />
          <button type="button" className="link" onClick={() => { URL.revokeObjectURL(photo.url); setPhoto(null) }}>Remove photo</button>
        </div>
      ) : (
        <label className="button secondary photo-add">
          <Icon name="plus" size={16} /> Add a photo of your food
          <input type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = '' }} />
        </label>
      )}
      {file && (
        <ImageCropper file={file} aspect={4 / 3} width={900} title="Your food photo" hint="Show off the food. Please keep people out of it."
          onCancel={() => setFile(null)} onDone={(blob) => { setFile(null); setPhoto({ blob, url: URL.createObjectURL(blob) }) }} />
      )}
      <p className="muted small">Your first name is shown with your review.</p>
      <button type="submit" disabled={busy}>{busy ? 'Posting…' : 'Post review'}</button>
      {message && <p className="error">{message}</p>}
    </form>
  )
}
