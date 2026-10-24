import { useState } from 'react'
import { Icon } from './icons'
import { turnOffPush, turnOnPush, usePushState } from './push'

const TEXT = {
  seller: { title: 'Get new orders on your phone', body: 'A notification the moment an order comes in, even when BiteBY is closed.' },
  customer: { title: 'Know when your food is ready', body: 'Get a notification when the cook accepts, and when it’s ready or on its way.' },
  settings: { title: 'Phone notifications', body: 'New orders, messages and updates, even when BiteBY is closed.' },
}

// A prompt to switch on phone notifications. `settings` shows an on/off
// switch; the others only show while notifications are off.
export function PushCard({ kind }: { kind: keyof typeof TEXT }) {
  const [state, setState] = usePushState()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const t = TEXT[kind]

  if (!state || state === 'unsupported' || state === 'not_ready') return null
  if (kind !== 'settings' && state === 'on') return null

  async function toggle(on: boolean) {
    setBusy(true)
    setMessage('')
    try {
      setState(on ? await turnOnPush() : await turnOffPush())
    } catch (e) {
      setMessage((e as Error).message)
    }
    setBusy(false)
  }

  return (
    <div className={`card push-card ${kind === 'settings' ? '' : 'push-prompt'}`}>
      <div className="sum-row">
        <span className="set-icon"><Icon name="bell" size={22} filled /></span>
        <span className="sum-text">
          <strong>{t.title}</strong>
          <span className="small muted">
            {state === 'needs_install' ? 'On iPhone, add BiteBY to your Home Screen first: tap Share, then “Add to Home Screen”.'
              : state === 'blocked' ? 'Notifications are blocked for BiteBY. Allow them in your phone’s settings, then come back.'
              : t.body}
          </span>
        </span>
        {kind === 'settings' && (state === 'on' || state === 'off') && (
          <input type="checkbox" className="switch" checked={state === 'on'} disabled={busy} onChange={(e) => toggle(e.target.checked)} aria-label="Phone notifications" />
        )}
      </div>
      {kind !== 'settings' && state === 'off' && (
        <button type="button" disabled={busy} onClick={() => toggle(true)}>{busy ? 'Turning on…' : 'Turn on notifications'}</button>
      )}
      {message && <p className="error small">{message}</p>}
    </div>
  )
}
