import { Component, type ReactNode } from 'react'
import { supabase } from './supabase'

// Bug alerts: errors people hit are sent to the BiteBY admin (Admin > Bugs).
// Only the error itself, the page and the browser are sent, never what was
// typed. The same error is only sent once per visit.

const sent = new Set<string>()
declare const __BUILD_TIME__: string
const VERSION = __BUILD_TIME__

// Things that aren't our bugs: browser extensions, lost connections, ads.
const IGNORE = /ResizeObserver loop|Load failed|Failed to fetch|NetworkError|chrome-extension:|moz-extension:|safari-extension:|Script error\.?$|AbortError|The operation was aborted/i

export function reportError(error: unknown, where?: string) {
  const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error)?.slice(0, 300) ?? 'Unknown error')
  const message = `${where ? `${where}: ` : ''}${e.name && e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}`.slice(0, 300)
  if (IGNORE.test(message) || IGNORE.test(e.stack ?? '') || sent.has(message) || sent.size > 20) return
  sent.add(message)
  supabase?.rpc('log_client_error', {
    p_message: message,
    p_stack: e.stack?.slice(0, 2000) ?? null,
    p_page: window.location.pathname.slice(0, 200),
    p_agent: navigator.userAgent.slice(0, 200),
    p_version: VERSION,
  }).then(() => {}, () => {})
}

export function watchErrors() {
  window.addEventListener('error', (ev) => reportError(ev.error ?? ev.message))
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason))
}

// If a page crashes, show a friendly message instead of a blank screen.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    reportError(error, 'Page crashed')
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="crash">
        <h1>Sorry, something went wrong</h1>
        <p className="muted">We’ve been told about it and will fix it. Reloading usually helps.</p>
        <div className="row">
          <button type="button" onClick={() => window.location.reload()}>Reload</button>
          <button type="button" className="secondary" onClick={() => { window.location.href = '/' }}>Go to home</button>
        </div>
      </div>
    )
  }
}
