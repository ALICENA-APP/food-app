import { supabase } from './supabase'

export type Hours = { weekday: number; opens: string; closes: string }
export type OpenState = { open: boolean; label: string } | null

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// Day of the week (0 = Monday), minutes past midnight and date, in London time.
export function londonNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(now).map((p) => [p.type, p.value]),
  )
  return {
    weekday: DAY.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    date: now.toLocaleDateString('en-CA', { timeZone: 'Europe/London' }),
  }
}

// "2026-10-16" plus a number of days, as a date string again.
export function addDays(date: string, days: number) {
  const d = new Date(date + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export const shortDate = (date: string) => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

// The cook's next run of days off starting today, if any: "back on" is the day after.
export function awayUntil(closedDates: string[], today = londonNow().date): string | null {
  if (!closedDates.includes(today)) return null
  let d = today
  while (closedDates.includes(addDays(d, 1))) d = addDays(d, 1)
  return addDays(d, 1)
}

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

// "Open now · until 18:00", "Opens 17:00", "Opens Tue 10:00" or "Closed today".
// Null when the shop hasn't set opening hours.
export function openState(hours: Hours[], closedDates: string[], now = londonNow()): OpenState {
  const closedToday = closedDates.includes(now.date)
  if (!hours.length) return null
  const today = hours.filter((h) => h.weekday === now.weekday).sort((a, b) => mins(a.opens) - mins(b.opens))
  if (!closedToday) {
    const current = today.find((h) => mins(h.opens) <= now.minutes && now.minutes < mins(h.closes))
    if (current) return { open: true, label: `Open now · until ${current.closes.slice(0, 5)}` }
    const later = today.find((h) => mins(h.opens) > now.minutes)
    if (later) return { open: false, label: `Opens ${later.opens.slice(0, 5)}` }
  }
  for (let i = 1; i <= 60; i++) {
    const day = (now.weekday + i) % 7
    const next = hours.filter((h) => h.weekday === day).sort((a, b) => mins(a.opens) - mins(b.opens))[0]
    if (next && !closedDates.includes(addDays(now.date, i))) {
      const when = i === 1 ? `tomorrow ${next.opens.slice(0, 5)}` : i < 7 ? `${DAY[day]} ${next.opens.slice(0, 5)}` : shortDate(addDays(now.date, i))
      return { open: false, label: closedToday ? `Closed today · opens ${when}` : `Opens ${when}` }
    }
  }
  return { open: false, label: 'Closed today' }
}

// Open/closed state for a list of shops.
export async function loadOpenStates(shopIds: string[]): Promise<Record<string, OpenState>> {
  const ids = [...new Set(shopIds)]
  if (!ids.length) return {}
  const now = londonNow()
  const [h, c] = await Promise.all([
    supabase!.from('shop_hours').select('shop_id, weekday, opens, closes').in('shop_id', ids),
    supabase!.from('shop_closures').select('shop_id, closed_on').in('shop_id', ids).gte('closed_on', now.date).lte('closed_on', addDays(now.date, 60)),
  ])
  const closed = (id: string) => (c.data ?? []).filter((x) => x.shop_id === id).map((x) => x.closed_on)
  return Object.fromEntries(ids.map((id) => [id, openState((h.data ?? []).filter((x) => x.shop_id === id), closed(id), now)]))
}
