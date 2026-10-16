import { useEffect, useSyncExternalStore } from 'react'
import { supabase } from './supabase'

// The signed-in person's profile picture, shared by the top bar and Profile.
let state: { userId: string; path: string | null } | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function setMyAvatar(userId: string, path: string | null) {
  state = { userId, path }
  emit()
}

export function useMyAvatar(userId: string | undefined): string | null {
  const current = useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l) },
    () => state,
  )
  useEffect(() => {
    if (!userId || state?.userId === userId) return
    supabase!.from('profiles').select('avatar_path').eq('id', userId).maybeSingle()
      .then(({ data }) => setMyAvatar(userId, data?.avatar_path ?? null))
  }, [userId])
  return current && current.userId === userId ? current.path : null
}
