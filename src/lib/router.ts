import { useEffect, useState, type MouseEvent } from 'react'

// Tiny path router: enough for a handful of screens without a dependency.
// Netlify's SPA redirect sends every path to index.html.
export function usePath() {
  const [path, setPath] = useState(window.location.pathname + window.location.search)
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return path.split('?')[0]
}

// One value from the address bar's query, e.g. ?q=cake.
export function queryParam(name: string) {
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

export function navigate(to: string, replace = false) {
  if (to === window.location.pathname + window.location.search) return
  if (replace) window.history.replaceState(null, '', to)
  else window.history.pushState({ inApp: true }, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
  if (!replace) window.scrollTo(0, 0)
}

// Back to the previous screen, or `fallback` when the page was opened directly.
export function goBack(fallback = '/') {
  if (window.history.state?.inApp) window.history.back()
  else navigate(fallback)
}

// Click handler for in-app links: keeps the page from reloading.
export function link(to: string) {
  return (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return
    e.preventDefault()
    navigate(to)
  }
}
