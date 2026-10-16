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

const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

// "Open now · until 18:00", "Opens 17:00", "Opens Tue 10:00" or "Closed today".
// Null when the shop hasn't set opening hours.
export function openState(hours: Hours[], closedToday: boolean, now = londonNow()): OpenState {
  if (!hours.length) return null
  const today = hours.filter((h) => h.weekday === now.weekday).sort((a, b) => mins(a.opens) - mins(b.opens))
  if (!closedToday) {
    const current = today.find((h) => mins(h.opens) <= now.minutes && now.minutes < mins(h.closes))
    if (current) return { open: true, label: `Open now · until ${current.closes.slice(0, 5)}` }
    const later = today.find((h) => mins(h.opens) > now.minutes)
    if (later) return { open: false, label: `Opens ${later.opens.slice(0, 5)}` }
  }
  for (let i = 1; i <= 7; i++) {
    const day = (now.weekday + i) % 7
    const next = hours.filter((h) => h.weekday === day).sort((a, b) => mins(a.opens) - mins(b.opens))[0]
    if (next) {
      const when = `${i === 1 ? 'tomorrow' : DAY[day]} ${next.opens.slice(0, 5)}`
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
    supabase!.from('shop_closures').select('shop_id').in('shop_id', ids).eq('closed_on', now.date),
  ])
  const closed = new Set((c.data ?? []).map((x) => x.shop_id))
  return Object.fromEntries(ids.map((id) => [id, openState((h.data ?? []).filter((x) => x.shop_id === id), closed.has(id), now)]))
}
