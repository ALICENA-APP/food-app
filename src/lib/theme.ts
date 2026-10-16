import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'
const KEY = 'theme'
const listeners = new Set<() => void>()
const media = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

// Sets light or dark on the page, following the phone's setting for "system".
export function applyTheme(choice = readTheme()) {
  const dark = choice === 'dark' || (choice === 'system' && Boolean(media?.matches))
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#121212' : '#FFC72C')
}

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch {
    // storage unavailable: still switch for this visit
  }
  applyTheme(choice)
  listeners.forEach((l) => l())
}

media?.addEventListener?.('change', () => applyTheme())

export function useTheme() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, readTheme, () => 'system' as ThemeChoice)
}
