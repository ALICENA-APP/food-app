import { useEffect, useState } from 'react'
import { Icon } from './icons'

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }

// Chrome and Android fire this early; keep it until the banner is shown.
let deferred: InstallEvent | null = null
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as InstallEvent
  window.dispatchEvent(new Event('install-ready'))
})

const KEY = 'installDismissed'
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)

function dismissedRecently() {
  try {
    return Date.now() - Number(localStorage.getItem(KEY) ?? 0) < 14 * 86400000
  } catch {
    return false
  }
}

// "Add BiteBY to your home screen" banner: one tap on Android, a short how-to on iPhone.
export function InstallPrompt() {
  const [ready, setReady] = useState(Boolean(deferred))
  const [hidden, setHidden] = useState(() => standalone() || dismissedRecently())
  const [showIosHelp, setShowIosHelp] = useState(false)

  useEffect(() => {
    const on = () => setReady(true)
    window.addEventListener('install-ready', on)
    return () => window.removeEventListener('install-ready', on)
  }, [])

  if (hidden || (!ready && !isIos())) return null

  function dismiss() {
    try {
      localStorage.setItem(KEY, String(Date.now()))
    } catch {
      // storage unavailable
    }
    setHidden(true)
  }

  async function install() {
    if (deferred) {
      await deferred.prompt()
      const { outcome } = await deferred.userChoice
      deferred = null
      if (outcome === 'accepted') setHidden(true)
    } else {
      setShowIosHelp(true)
    }
  }

  return (
    <div className="card install">
      <div className="row-bar" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <img src="/icon-192.png" alt="" width={44} height={44} style={{ borderRadius: 10 }} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong>Get the BiteBY app</strong>
          <span className="muted small" style={{ display: 'block' }}>Add it to your home screen. It's free.</span>
        </span>
        <button type="button" className="small-btn" onClick={install}>Add</button>
        <button type="button" className="icon-btn" aria-label="Not now" onClick={dismiss}><Icon name="close" size={18} /></button>
      </div>
      {showIosHelp && (
        <p className="small">In Safari, tap the <strong>Share</strong> button <Icon name="share" size={16} /> at the bottom of the screen, then <strong>Add to Home Screen</strong>.</p>
      )}
    </div>
  )
}
