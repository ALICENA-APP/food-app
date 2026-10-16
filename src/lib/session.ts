import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { navigate } from './router'

// The signed-in person, shared by every screen. Supabase keeps the session in
// this browser and refreshes it, so people stay signed in between visits.
let current: Session | null = null
let ready = !supabase
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((f) => f())

if (supabase) {
  supabase.auth.getSession().then(({ data }) => {
    current = data.session
    ready = true
    emit()
  })
  supabase.auth.onAuthStateChange((event, s) => {
    current = s
    ready = true
    emit()
    // A password-reset link signs the person in; take them to choose a new password.
    if (event === 'PASSWORD_RECOVERY') setTimeout(() => navigate('/reset', true), 0)
    if (event === 'SIGNED_IN' && s) {
      // Name given at sign-up goes onto their profile the first time.
      const name = s.user.user_metadata?.name
      if (name) supabase!.from('profiles').update({ display_name: String(name).slice(0, 80) }).eq('id', s.user.id).is('display_name', null).then(() => {})

      // Return to the page the person was on when they asked to sign in.
      let back: string | null = null
      try {
        back = localStorage.getItem('afterSignIn')
        localStorage.removeItem('afterSignIn')
      } catch {
        // storage unavailable
      }
      if (back) setTimeout(() => navigate(back!, true), 0)
    }
  })
}

export function useSession() {
  const [, force] = useState(0)
  useEffect(() => {
    const f = () => force((n) => n + 1)
    listeners.add(f)
    return () => {
      listeners.delete(f)
    }
  }, [])
  return { session: current, ready }
}

// Sends people to sign in, then brings them back to `next`.
export function askToSignIn(next = window.location.pathname + window.location.search) {
  navigate(`/signin?next=${encodeURIComponent(next)}`)
}
