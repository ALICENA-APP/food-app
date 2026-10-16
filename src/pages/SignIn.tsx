import { useEffect, useState, type FormEvent } from 'react'
import { supabase } from '../lib/supabase'
import { goBack, link, navigate, queryParam } from '../lib/router'
import { useSession } from '../lib/session'
import { BackButton, Wordmark } from '../lib/ui'

type Mode = 'signin' | 'signup' | 'forgot' | 'link'

// Only pages inside the app, never another website.
function nextPath() {
  const next = queryParam('next')
  return next.startsWith('/') && !next.startsWith('//') ? next : '/'
}

function rememberNext() {
  try {
    localStorage.setItem('afterSignIn', nextPath())
  } catch {
    // storage unavailable: they land on the home page instead
  }
}

// Sign in or create an account with email and password. Email links are
// kept as a fallback, and for confirming new accounts and password resets.
export default function SignIn() {
  const { session } = useSession()
  const [mode, setMode] = useState<Mode>(queryParam('mode') === 'signup' ? 'signup' : 'signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reason = nextPath() === '/basket' ? 'Sign in to place your order. Your basket is saved.' : ''

  // Already signed in (or just signed in): carry on where they were going.
  useEffect(() => {
    if (session) navigate(nextPath(), true)
  }, [session])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setMessage('')
    setBusy(true)
    const auth = supabase!.auth
    const redirect = window.location.origin
    let result: { error: { message: string } | null }
    if (mode === 'signin') {
      result = await auth.signInWithPassword({ email, password })
      if (result.error?.message === 'Invalid login credentials') {
        result = { error: { message: "That email and password don't match. If you've only used email links before, tap \"Forgot password?\" to set one." } }
      }
    } else if (mode === 'signup') {
      rememberNext()
      const r = await auth.signUp({ email, password, options: { data: { name: name.trim() }, emailRedirectTo: redirect } })
      result = r
      if (!r.error && !r.data.session) setMessage(`Nearly done: we've sent a link to ${email}. Tap it to confirm your account.`)
    } else if (mode === 'forgot') {
      result = await auth.resetPasswordForEmail(email, { redirectTo: `${redirect}/reset` })
      if (!result.error) setMessage(`If there's an account for ${email}, we've sent a link to choose a new password.`)
    } else {
      rememberNext()
      result = await auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } })
      if (!result.error) setMessage('Check your email for a sign-in link.')
    }
    setBusy(false)
    if (result.error) setError(/rate limit/i.test(result.error.message) ? 'Too many emails sent just now. Please try again in an hour, or sign in with your password.' : result.error.message)
  }

  const title = { signin: 'Welcome back', signup: 'Create your account', forgot: 'Reset your password', link: 'Sign in with an email link' }[mode]

  return (
    <div className="stack">
      <div className="item">
        <BackButton onClick={() => goBack('/')} />
        <Wordmark size={26} />
        <span style={{ width: 42 }} />
      </div>
      <form className="card auth" onSubmit={onSubmit}>
        <h1 style={{ fontSize: '1.5rem' }}>{title}</h1>
        {reason && <p className="status small">{reason}</p>}
        {mode === 'signup' && (
          <label>
            First name
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoComplete="given-name" />
          </label>
        )}
        <label>
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
        </label>
        {(mode === 'signin' || mode === 'signup') && (
          <label>
            Password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder={mode === 'signup' ? 'At least 8 characters' : ''} />
          </label>
        )}
        <button type="submit" className="dark block" disabled={busy}>
          {busy ? 'Please wait…' : { signin: 'Sign in', signup: 'Create account', forgot: 'Send reset link', link: 'Email me a link' }[mode]}
        </button>
        {message && <p className="status small">{message}</p>}
        {error && <p className="error small">{error}</p>}

        {mode === 'signin' && (
          <div className="row wrap" style={{ justifyContent: 'space-between' }}>
            <button type="button" className="link" onClick={() => setMode('forgot')}>Forgot password?</button>
            <button type="button" className="link" onClick={() => setMode('link')}>Email me a link instead</button>
          </div>
        )}
        <p className="small" style={{ textAlign: 'center' }}>
          {mode === 'signup' ? 'Already have an account? ' : 'New to BiteBY? '}
          <button type="button" className="link" onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setMessage(''); setError('') }}>
            {mode === 'signup' ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
      <p className="muted small" style={{ textAlign: 'center' }}>
        You'll stay signed in on this device. <a href="/" onClick={link('/')}>Keep browsing</a>
      </p>
    </div>
  )
}

// Choose a new password after tapping the reset link (or set one for the first time).
export function SetPassword({ reset }: { reset?: boolean }) {
  const { session, ready } = useSession()
  const [password, setPassword] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    const { error: err } = await supabase!.auth.updateUser({ password })
    if (err) return setError(err.message)
    setPassword('')
    setMessage('Password saved. Next time you can sign in with your email and this password.')
  }

  if (!ready) return <p className="muted">Loading…</p>
  if (!session) {
    return (
      <div className="card">
        <h1 style={{ fontSize: '1.5rem' }}>Link expired</h1>
        <p className="muted">This link has expired or was already used. Ask for a new one.</p>
        <a className="button" href="/signin" onClick={link('/signin')}>Back to sign in</a>
      </div>
    )
  }
  return (
    <form className="card" onSubmit={onSubmit}>
      <h1 style={{ fontSize: '1.5rem' }}>{reset ? 'Choose a new password' : 'Password'}</h1>
      <p className="muted small">For {session.user.email}</p>
      <label>
        New password
        <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder="At least 8 characters" />
      </label>
      <button type="submit" className="dark">Save password</button>
      {message && <p className="status small">{message}</p>}
      {error && <p className="error small">{error}</p>}
      {message && <a className="button secondary" href="/" onClick={link('/')}>Go to home</a>}
    </form>
  )
}
