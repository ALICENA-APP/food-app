// Time left on a featured (sponsored) spot. Dates are whole days, and the
// end date is the last day featured.
const DAY = 86400000
const asDay = (d: string) => new Date(d + 'T12:00').getTime()
const today = () => asDay(new Date().toLocaleDateString('en-CA'))

export function daysLeft(end: string) {
  return Math.max(0, Math.round((asDay(end) - today()) / DAY) + 1)
}

export function daysLeftText(end: string) {
  const n = daysLeft(end)
  return n <= 1 ? 'Last day today' : `${n} days left`
}

// How much of the run has gone, as a bar.
export function FeaturedBar({ start, end }: { start: string; end: string }) {
  const total = Math.round((asDay(end) - asDay(start)) / DAY) + 1
  const used = Math.min(total, Math.max(0, total - daysLeft(end)))
  return (
    <div className="featured-bar" role="img" aria-label={`${used} of ${total} days used`}>
      <span style={{ width: `${(used / total) * 100}%` }} />
    </div>
  )
}
