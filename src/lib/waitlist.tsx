import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { askToSignIn, myUserId, useSession } from './session'
import { Icon } from './icons'
import { postcodeDistrict } from './postcode'

// "No cooks near you yet": sign up to hear when the first one opens nearby.
export function WaitlistCard({ postcode }: { postcode: string }) {
  const { session } = useSession()
  const district = postcodeDistrict(postcode)
  const [joined, setJoined] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session || !district) return
    myUserId().then((uid) => supabase!.from('area_waitlist').select('district').eq('user_id', uid).eq('district', district).maybeSingle())
      .then(({ data }) => setJoined(Boolean(data)))
  }, [session, district])

  if (!district) return null

  async function join() {
    if (!session) return askToSignIn(location.pathname)
    setBusy(true)
    setError('')
    const { error: err } = await supabase!.rpc('join_waitlist', { p_postcode: postcode })
    setBusy(false)
    if (err) return setError(err.message)
    setJoined(true)
  }

  return (
    <div className="tile appearance">
      <div className="head">
        <span className="ic" style={{ background: 'var(--yellow-soft)' }}><Icon name="bell" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>No cooks in {district} yet</span>
          <span className="s">{joined ? 'You’re on the list. We’ll tell you as soon as a cook opens near you.' : 'Get a notification when the first cook near you opens.'}</span>
        </span>
      </div>
      {!joined && <button type="button" disabled={busy} onClick={join}>{busy ? 'Saving…' : session ? 'Notify me' : 'Sign in to get notified'}</button>}
      {error && <p className="error small">{error}</p>}
    </div>
  )
}
