import { lazy, Suspense, type ReactNode } from 'react'
import { isConfigured } from './lib/supabase'
import { link, usePath } from './lib/router'
import { askToSignIn, useSession } from './lib/session'
import { basketCount, useBasket } from './lib/basket'
import { useUnreadAlerts } from './lib/alerts'
import { Icon, type IconName } from './lib/icons'
import { Avatar, Wordmark } from './lib/ui'
import { useMyAvatar } from './lib/myAvatar'
import Home from './pages/Home'
import Explore from './pages/Explore'
import Dish from './pages/Dish'
import PublicShop from './pages/PublicShop'
import Checkout from './pages/Checkout'
import { MyOrders, OrderDetail } from './pages/Orders'
import Profile, { Help } from './pages/Profile'
import Favourites from './pages/Favourites'
import Addresses from './pages/Addresses'
const Account = lazy(() => import('./pages/Account'))
const Legal = () => import('./pages/Legal')
const AllergenInfo = lazy(() => Legal().then((m) => ({ default: m.AllergenInfo })))
const Privacy = lazy(() => Legal().then((m) => ({ default: m.Privacy })))
const SellerTerms = lazy(() => Legal().then((m) => ({ default: m.SellerTerms })))
const Terms = lazy(() => Legal().then((m) => ({ default: m.Terms })))
import SignIn, { SetPassword } from './pages/SignIn'
import Alerts from './pages/Alerts'
const SellerHome = lazy(() => import('./pages/SellerHome'))
const ShopSetup = lazy(() => import('./pages/ShopSetup'))
const Products = lazy(() => import('./pages/Products'))
const ProductEditor = lazy(() => import('./pages/ProductEditor'))
const SellerOrders = lazy(() => import('./pages/SellerOrders'))
const SellerEarnings = lazy(() => import('./pages/SellerInsights').then((m) => ({ default: m.SellerEarnings })))
const SellerReviews = lazy(() => import('./pages/SellerInsights').then((m) => ({ default: m.SellerReviews })))
const Admin = lazy(() => import('./pages/Admin'))
const Poster = lazy(() => import('./pages/Poster'))
const Discounts = lazy(() => import('./pages/Discounts'))
const Statement = lazy(() => import('./pages/Statements'))
import { MyRequests } from './lib/help'

const TABS: { to: string; label: string; icon: IconName }[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/explore', label: 'Explore', icon: 'search' },
  { to: '/basket', label: 'Basket', icon: 'basket' },
  { to: '/orders', label: 'Orders', icon: 'orders' },
  { to: '/profile', label: 'Profile', icon: 'user' },
]

// Pages that show their own photo header instead of the BiteBY top bar.
const FULL_BLEED = /^\/s\/[a-z0-9-]+(\/i\/[0-9a-f-]{36})?\/?$|^\/signin\/?$/

function App() {
  const path = usePath()
  const { session, ready } = useSession()
  const basket = useBasket()
  const unread = useUnreadAlerts(session?.user.id)
  const avatar = useMyAvatar(session?.user.id)
  const count = basketCount(basket)

  const shopMatch = path.match(/^\/s\/([a-z0-9-]+)\/?$/)
  const dishMatch = path.match(/^\/s\/([a-z0-9-]+)\/i\/([0-9a-f-]{36})\/?$/)
  const orderMatch = path.match(/^\/orders\/([0-9a-f-]{36})\/?$/)
  const productMatch = path.match(/^\/sell\/products\/([0-9a-f-]{36}|new)\/?$/)

  // Screens that need an account send people to sign in, then straight back.
  const needsAccount = (el: ReactNode, why: string) => (session ? el : <SignInPrompt why={why} />)

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
  } else if (dishMatch) {
    page = <Dish slug={dishMatch[1]} productId={dishMatch[2]} />
  } else if (shopMatch) {
    page = <PublicShop slug={shopMatch[1]} />
  } else if (path === '/explore') {
    page = <Explore />
  } else if (path === '/basket') {
    page = <Checkout />
  } else if (path === '/signin') {
    page = <SignIn />
  } else if (path === '/reset') {
    page = <SetPassword reset />
  } else if (path === '/terms') {
    page = <Terms />
  } else if (path === '/privacy') {
    page = <Privacy />
  } else if (path === '/allergens') {
    page = <AllergenInfo />
  } else if (path === '/seller-terms') {
    page = <SellerTerms />
  } else if (path === '/help/requests') {
    page = needsAccount(<MyRequests />, 'Sign in to see your messages to the BiteBY team.')
  } else if (path === '/help') {
    page = <Help />
  } else if (path === '/profile') {
    page = <Profile />
  } else if (path === '/account/password') {
    page = needsAccount(<SetPassword />, 'Sign in to change your password.')
  } else if (path === '/account/statement') {
    page = needsAccount(<Statement kind="customer" />, 'Sign in to see your orders.')
  } else if (path === '/account') {
    page = needsAccount(<Account />, 'Sign in to manage your account.')
  } else if (path === '/addresses') {
    page = needsAccount(<Addresses />, 'Sign in to manage your saved addresses.')
  } else if (path === '/favourites') {
    page = needsAccount(<Favourites />, 'Sign in to see the dishes and cooks you have saved.')
  } else if (path === '/alerts') {
    page = needsAccount(<Alerts />, 'Sign in to see your notifications.')
  } else if (path === '/orders' || orderMatch) {
    page = needsAccount(orderMatch ? <OrderDetail id={orderMatch[1]} /> : <MyOrders />, 'Sign in to see and track your orders.')
  } else if (path.startsWith('/admin')) {
    page = needsAccount(<Admin />, 'Sign in to the BiteBY team tools.')
  } else if (path.startsWith('/sell')) {
    if (!session) page = <SignInPrompt why="Sign in or create an account to open your food shop." />
    else if (path === '/sell/shop') page = <ShopSetup />
    else if (path === '/sell/poster') page = <Poster />
    else if (path === '/sell/discounts') page = <Discounts />
    else if (path === '/sell/statement') page = <Statement kind="seller" />
    else if (path === '/sell/earnings') page = <SellerEarnings />
    else if (path === '/sell/reviews') page = <SellerReviews />
    else if (path === '/sell/orders') page = <SellerOrders />
    else if (path === '/sell/products') page = <Products />
    else if (productMatch) page = <ProductEditor productId={productMatch[1] === 'new' ? null : productMatch[1]} />
    else page = <SellerHome />
  } else {
    page = <Home />
  }

  const name = session?.user.user_metadata?.name || session?.user.email || ''
  const activeTab = path === '/' ? '/' : TABS.slice(1).find((t) => path.startsWith(t.to))?.to
    ?? (path.startsWith('/sell') || path.startsWith('/favourites') || path === '/addresses' || path.startsWith('/account') || ['/help', '/help/requests', '/alerts', '/terms', '/privacy', '/allergens', '/seller-terms'].includes(path) ? '/profile' : null)

  return (
    <>
      <main className="app">
        {!FULL_BLEED.test(path) && (
          <header className="topbar">
            <Wordmark />
            <div className="actions">
              {session && (
                <a className="icon-btn" href="/alerts" onClick={link('/alerts')} aria-label={`Notifications, ${unread} new`}>
                  <Icon name="bell" />
                  {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
                </a>
              )}
              {session ? (
                <a href="/profile" onClick={link('/profile')} aria-label="Your profile"><Avatar name={name} path={avatar} size={42} /></a>
              ) : (
                <button type="button" className="small-btn" onClick={() => askToSignIn()}>Sign in</button>
              )}
            </div>
          </header>
        )}
        <Suspense fallback={<p className="muted">Loading…</p>}>{page}</Suspense>
      </main>
      <nav className="bottom-nav" aria-label="Main">
        <div className="inner">
          {TABS.map((t) => (
            <a key={t.to} href={t.to} onClick={link(t.to)} className={activeTab === t.to ? 'on' : ''} aria-current={activeTab === t.to ? 'page' : undefined}>
              <span className="icon">
                <Icon name={t.icon} filled={activeTab === t.to} />
                {t.to === '/basket' && count > 0 && <span className="badge">{count > 9 ? '9+' : count}</span>}
              </span>
              {t.label}
            </a>
          ))}
        </div>
      </nav>
    </>
  )
}

function SignInPrompt({ why }: { why: string }) {
  const next = window.location.pathname + window.location.search
  return (
    <div className="card empty">
      <span className="big">👋</span>
      <h2 style={{ color: 'var(--text)' }}>Sign in to carry on</h2>
      <p>{why}</p>
      <a className="button dark" href={`/signin?next=${encodeURIComponent(next)}`} onClick={link(`/signin?next=${encodeURIComponent(next)}`)}>Sign in</a>
      <a className="button secondary" href={`/signin?mode=signup&next=${encodeURIComponent(next)}`} onClick={link(`/signin?mode=signup&next=${encodeURIComponent(next)}`)}>Create an account</a>
    </div>
  )
}

export default App
