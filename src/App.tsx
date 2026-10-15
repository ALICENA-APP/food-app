import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'
import { link, navigate, usePath } from './lib/router'
import SellerHome from './pages/SellerHome'
import ShopSetup from './pages/ShopSetup'
import Products from './pages/Products'
import ProductEditor from './pages/ProductEditor'
import PublicShop from './pages/PublicShop'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!supabase)
  const path = usePath()

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'SIGNED_IN') {
        // Return to the page the person was on when they asked for the link.
        let back: string | null = null
        try {
          back = localStorage.getItem('afterSignIn')
          localStorage.removeItem('afterSignIn')
        } catch {
          // storage unavailable
        }
        if (back) navigate(back)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const shopMatch = path.match(/^\/s\/([a-z0-9-]+)\/?$/)
  const productMatch = path.match(/^\/sell\/products\/([0-9a-f-]{36}|new)\/?$/)

  let page
  if (!isConfigured) {
    page = (
      <p className="notice">
        Almost there: add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to
        connect the app to Supabase.
      </p>
    )
  } else if (!ready) {
    page = <p className="muted">Loading…</p>
  } else if (shopMatch) {
    page = <PublicShop slug={shopMatch[1]} />
  } else if (path.startsWith('/sell')) {
    if (!session) {
      page = (
        <>
          <p className="lead">Sign in to set up your shop.</p>
          <SignIn redirectPath={path} />
        </>
      )
    } else if (path === '/sell/shop') {
      page = <ShopSetup />
    } else if (path === '/sell/products') {
      page = <Products />
    } else if (productMatch) {
      page = <ProductEditor productId={productMatch[1] === 'new' ? null : productMatch[1]} />
    } else {
      page = <SellerHome />
    }
  } else {
    page = (
      <>
        <p className="lead">
          Homemade food from cooks near you. Coming soon to East London.
        </p>
        <div className="card">
          <h2>Cook at home?</h2>
          <p className="muted">
            Open your own little online food shop with a link you can share. No monthly fee, we
            take 5% of the food price only when you sell.
          </p>
          <a className="button" href="/sell" onClick={link('/sell')}>
            Start selling
          </a>
        </div>
        {!session && (
          <div style={{ marginTop: 16 }}>
            <SignIn redirectPath="/" />
          </div>
        )}
      </>
    )
  }

  return (
    <main className="app">
      <header>
        <a className="brand" href="/" onClick={link('/')}>
          Homemade Food
        </a>
        {session && (
          <button className="link" onClick={() => supabase!.auth.signOut()}>
            Sign out
          </button>
        )}
      </header>
      {page}
    </main>
  )
}

function SignIn({ redirectPath }: { redirectPath: string }) {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    try {
      localStorage.setItem('afterSignIn', redirectPath)
    } catch {
      // storage unavailable: they land on the home page instead
    }
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
