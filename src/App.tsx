import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'

type Item = { id: string; name: string; created_at: string }

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
        <h1>Food App</h1>
        {session && (
          <button className="link" onClick={() => supabase!.auth.signOut()}>
            Sign out
          </button>
        )}
      </header>
      {!isConfigured ? (
        <p className="notice">
          Almost there: add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to
          connect the app to Supabase.
        </p>
      ) : session ? (
        <Foods />
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

function Foods() {
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  async function load() {
    const { data, error } = await supabase!
      .from('items')
      .select('id, name, created_at')
      .order('created_at', { ascending: false })
    if (error) setError(error.message)
    else setItems(data ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  async function add(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const { error } = await supabase!.from('items').insert({ name: trimmed })
    if (error) return setError(error.message)
    setName('')
    load()
  }

  async function remove(id: string) {
    const { error } = await supabase!.from('items').delete().eq('id', id)
    if (error) return setError(error.message)
    setItems((all) => all.filter((i) => i.id !== id))
  }

  return (
    <section className="card">
      <form onSubmit={add} className="row">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Add a food" />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">No foods yet. Add your first one above.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <button className="link" onClick={() => remove(item.id)} aria-label={`Remove ${item.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export default App
