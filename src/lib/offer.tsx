import { useFoundingSpots } from './platform'

// The welcome offer: a pill, plus a progress bar of founding spots while
// the offer is only for the first cooks.
export function OfferBadge({ text }: { text: string }) {
  const spots = useFoundingSpots()
  if (!spots) return <span className="offer-badge">{text}</span>
  const left = spots.total - spots.taken
  return (
    <span className="founding">
      <strong>{text}</strong>
      <span className="founding-bar" role="progressbar" aria-valuemin={0} aria-valuemax={spots.total} aria-valuenow={spots.taken}>
        <span style={{ width: `${Math.max(4, (spots.taken / spots.total) * 100)}%` }} />
      </span>
      <span className="founding-meta">
        <span>{spots.taken} joined</span>
        <span>{left} {left === 1 ? 'spot' : 'spots'} left</span>
      </span>
    </span>
  )
}
