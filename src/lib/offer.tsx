import { useSpotsLeft } from './platform'

// The welcome offer pill, with how many founding spots are left.
export function OfferBadge({ text }: { text: string }) {
  const left = useSpotsLeft()
  return (
    <span className="offer-row">
      <span className="offer-badge">{text}</span>
      {left && <span className="spots-left">{left}</span>}
    </span>
  )
}
