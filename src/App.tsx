import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { isConfigured, supabase } from './lib/supabase'
import { link, navigate, usePath } from './lib/router'
import SellerHome from './pages/SellerHome'
import ShopSetup from './pages/ShopSetup'
import Products from './pages/Products'
import ProductEditor from './pages/ProductEditor'
import PublicShop from './pages/PublicShop'
import Admin from './pages/Admin'
import Browse from './pages/Browse'
import Checkout from './pages/Checkout'
import SellerOrders from './pages/SellerOrders'
import { SellerEarnings, SellerReviews } from './pages/SellerInsights'
import { MyOrders, OrderDetail } from './pages/Orders'
import { basketCount, useBasket } from './lib/basket'
import { useUnreadAlerts } from './lib/alerts'
import Alerts from './pages/Alerts'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(!supabase)
  const path = usePath()
  const basket = useBasket()
  const [isAdmin, setIsAdmin] = useState(false)
  const userId = session?.user.id
  const unread = useUnreadAlerts(userId)

  useEffect(() => {
    if (!userId) return setIsAdmin(false)
    supabase!.rpc('am_i_admin').then(({ data }) => setIsAdmin(Boolean(data)))
  }, [userId])

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
  const orderMatch = path.match(/^\/orders\/([0-9a-f-]{36})\/?$/)
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
  } else if (path === '/alerts') {
    page = session ? <Alerts /> : <SignIn redirectPath="/alerts" />
  } else if (path === '/basket') {
    page = session ? <Checkout /> : (
      <>
        <p className="lead">Sign in to place your order. Your basket is saved.</p>
        <SignIn redirectPath="/basket" />
      </>
    )
  } else if (path === '/orders' || orderMatch) {
    page = !session ? <SignIn redirectPath={path} /> : orderMatch ? <OrderDetail id={orderMatch[1]} /> : <MyOrders />
  } else if (path.startsWith('/admin')) {
    page = session ? <Admin /> : <SignIn redirectPath="/admin" />
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
    } else if (path === '/sell/earnings') {
      page = <SellerEarnings />
    } else if (path === '/sell/reviews') {
      page = <SellerReviews />
    } else if (path === '/sell/orders') {
      page = <SellerOrders />
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
        <Browse />
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
        <nav>
          {basketCount(basket) > 0 && (
            <a href="/basket" onClick={link('/basket')}>Basket ({basketCount(basket)})</a>
          )}
          {session && <a href="/orders" onClick={link('/orders')}>Orders</a>}
          {session && (
            <a href="/alerts" onClick={link('/alerts')} aria-label={`Alerts, ${unread} new`}>
              🔔{unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
            </a>
          )}
          <a href="/sell" onClick={link('/sell')}>Sell</a>
          {isAdmin && <a href="/admin" onClick={link('/admin')}>Admin</a>}
          {session && (
            <button className="link" onClick={() => supabase!.auth.signOut()}>
              Sign out
            </button>
          )}
        </nav>
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
