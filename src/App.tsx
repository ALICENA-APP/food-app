import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'

// Placeholder shell. Real screens follow the Technical V1 Blueprint, section 11.
function App() {
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  return (
    <main className="app">
      <header>
        <h1>Homemade Food</h1>
        {session && (
          <button className="link" onClick={() => supabase!.auth.signOut()}>
            Sign out
          </button>
        )}
      </header>
      <p className="lead">Your own online food shop inside a local marketplace. Coming soon to East London.</p>
      {!isConfigured ? (
        <p className="notice">
          Almost there: add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to
          connect the app to Supabase.
        </p>
      ) : session ? (
        <p className="card">Signed in as {session.user.email}.</p>
      ) : (
        <SignIn />
      )}
    </main>
  )
}

function SignIn() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const { error } = await supabase!.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    setMessage(error ? error.message : 'Check your email for a sign-in link.')
  }

  return (
    <form onSubmit={onSubmit} className="card">
      <label htmlFor="email">Sign in with your email</label>
      <input
        id="email"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
      />
      <button type="submit">Send me a link</button>
      {message && <p className="muted">{message}</p>}
    </form>
  )
}

export default App
