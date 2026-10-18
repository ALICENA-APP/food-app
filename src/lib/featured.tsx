import { useEffect, useState } from 'react'

// Featured (sponsored) spots run for exactly the time bought, from the moment
// they start.
const ms = (iso: string) => new Date(iso).getTime()

// A live countdown, e.g. "9d 04h 12m 30s".
export function Countdown({ end }: { end: string }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  const left = Math.max(0, Math.floor((ms(end) - now) / 1000))
  if (left === 0) return <span>Ended</span>
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(left / 86400)
  const h = Math.floor((left % 86400) / 3600)
  const m = Math.floor((left % 3600) / 60)
  return <span className="countdown" aria-label="Time left">{d > 0 && `${d}d `}{pad(h)}h {pad(m)}m {pad(left % 60)}s</span>
}

// How much of the run has gone, as a bar.
export function FeaturedBar({ start, end }: { start: string; end: string }) {
  const total = ms(end) - ms(start)
  const used = Math.min(1, Math.max(0, (Date.now() - ms(start)) / total))
  return (
    <div className="featured-bar" role="img" aria-label={`${Math.round(used * 100)}% of the time used`}>
      <span style={{ width: `${used * 100}%` }} />
    </div>
  )
}

// "Tue 27 Oct at 23:36"
export function moment(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

export const isRunning = (p: { status: string; starts_at: string | null; ends_at: string | null }) =>
  p.status === 'active' && !!p.starts_at && !!p.ends_at && ms(p.starts_at) <= Date.now() && ms(p.ends_at) > Date.now()
export const isBooked = (p: { status: string; starts_at: string | null }) =>
  p.status === 'active' && !!p.starts_at && ms(p.starts_at) > Date.now()
