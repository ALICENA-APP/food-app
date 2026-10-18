import { useEffect, useState } from 'react'

// Time left on a featured (sponsored) spot. Dates are whole UK days, and the
// end date is the last day featured.
const DAY = 86400000
const asDay = (d: string) => new Date(d + 'T12:00').getTime()
const today = () => asDay(new Date().toLocaleDateString('en-CA'))

export function daysLeft(end: string) {
  return Math.max(0, Math.round((asDay(end) - today()) / DAY) + 1)
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

// The moment a spot ends: midnight UK time after its last day.
export function endsAt(end: string) {
  const [y, m, d] = end.split('-').map(Number)
  const utc = Date.UTC(y, m - 1, d + 1)
  const ukHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(new Date(utc)))
  return utc - ukHour * 3600000
}

// A live countdown, e.g. "9d 04h 12m 30s".
export function Countdown({ end }: { end: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.floor((endsAt(end) - now) / 1000))
  if (left === 0) return <span>Ended</span>
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(left / 86400)
  const h = Math.floor((left % 86400) / 3600)
  const m = Math.floor((left % 3600) / 60)
  return <span className="countdown" aria-label="Time left">{d > 0 && `${d}d `}{pad(h)}h {pad(m)}m {pad(left % 60)}s</span>
}

// "Ends Tue 27 Oct at midnight"
export function endsText(end: string) {
  return `Ends ${new Date(end + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at midnight`
}
