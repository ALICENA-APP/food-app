import { useEffect, useState } from 'react'
import { supabase } from './supabase'

export type Alert = { id: number; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }

// Short two-note chime for a new alert (no sound file needed).
function chime() {
  try {
    const ctx = new AudioContext()
    ;[880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.18)
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.18 + 0.4)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + i * 0.18)
      osc.stop(ctx.currentTime + i * 0.18 + 0.4)
    })
  } catch {
    // sound not available
  }
}

function popUp(a: Alert) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  try {
    const n = new Notification(a.title, { body: a.body ?? undefined, icon: '/icon-192.png', tag: String(a.id) })
    n.onclick = () => {
      window.focus()
      if (a.link) window.location.href = a.link
    }
  } catch {
    // some phones only allow pop-ups from an installed app
  }
}

// Number of unread alerts, kept live: Realtime when connected, plus a check
// every minute as a fallback.
export function useUnreadAlerts(userId: string | undefined) {
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!userId || !supabase) return setUnread(0)
    const db = supabase
    let alive = true
    const count = async () => {
      const { count: n } = await db.from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null)
      if (alive) setUnread(n ?? 0)
    }
    count()
    const timer = window.setInterval(count, 60000)
    const onRead = () => count()
    window.addEventListener('alerts-read', onRead)
    const channel = db
      .channel(`alerts-${userId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'food', table: 'notifications', filter: `user_id=eq.${userId}` }, (payload) => {
        chime()
        popUp(payload.new as Alert)
        count()
      })
      .subscribe()
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('alerts-read', onRead)
      db.removeChannel(channel)
    }
  }, [userId])

  return unread
}

export async function markAllRead() {
  await supabase!.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null)
  window.dispatchEvent(new Event('alerts-read'))
}

// Expires old unpaid/unanswered orders. Safe to call often.
export function tidyOrders() {
  supabase?.rpc('expire_stale_orders').then(() => {}, () => {})
}
