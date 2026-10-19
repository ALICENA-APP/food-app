import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { supabase } from '../lib/supabase'
import { link, navigate } from '../lib/router'
import { useSession } from '../lib/session'
import { Icon, type IconName } from '../lib/icons'
import { Avatar, BowlArt, useFavourites } from '../lib/ui'
import { HelpForm } from '../lib/help'
import { setTheme, useTheme } from '../lib/theme'
import { ImageCropper } from '../lib/ImageCropper'
import { deletePhoto, uploadPhoto } from '../lib/images'
import { setMyAvatar, useMyAvatar } from '../lib/myAvatar'
import { useCommission, useWelcomeDetail, useWelcomeHeadline, useWelcomeOffer } from '../lib/platform'
import { OfferBadge } from '../lib/offer'

// Light, dark, or follow the phone.
function ThemePicker() {
  const theme = useTheme()
  return (
    <div className="tile appearance">
      <div className="head">
        <span className="ic" style={{ background: 'var(--line)' }}><Icon name="moon" /></span>
        <span style={{ minWidth: 0 }}>
          <span className="t" style={{ display: 'block' }}>Appearance</span>
          <span className="s">Light, dark, or the same as your phone</span>
        </span>
      </div>
      <div className="segmented" role="radiogroup" aria-label="Appearance">
        {(['system', 'light', 'dark'] as const).map((t) => (
          <label key={t} className={theme === t ? 'on not_present' : ''}>
            <input type="radio" name="appearance" checked={theme === t} onChange={() => setTheme(t)} />
            {t === 'system' ? 'Phone' : t === 'light' ? 'Light' : 'Dark'}
          </label>
        ))}
      </div>
    </div>
  )
}

function Tile({ to, icon, title, sub, tone = 'var(--yellow-soft)', wide, onClick }: {
  to?: string; icon: IconName; title: string; sub?: string; tone?: string; wide?: boolean; onClick?: () => void
}) {
  const body: ReactNode = (
    <>
      <span className="ic" style={{ background: tone }}><Icon name={icon} /></span>
      <span style={{ minWidth: 0 }}>
        <span className="t" style={{ display: 'block' }}>{title}</span>
        {sub && <span className="s">{sub}</span>}
      </span>
    </>
  )
  if (onClick) return <button type="button" className={`tile ${wide ? 'wide' : ''}`} onClick={onClick}>{body}</button>
  return <a className={`tile ${wide ? 'wide' : ''}`} href={to} onClick={link(to!)}>{body}</a>
}

export default function Profile() {
  const { session } = useSession()
  const { favs } = useFavourites()
  const [name, setName] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [reviews, setReviews] = useState(0)
  const [isSeller, setIsSeller] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const userId = session?.user.id

  useEffect(() => {
    if (!userId) return
    const db = supabase!
    db.from('profiles').select('display_name').eq('id', userId).maybeSingle().then(({ data }) => setName(data?.display_name ?? ''))
    db.from('reviews').select('id', { count: 'exact', head: true }).eq('customer_id', userId).then(({ count }) => setReviews(count ?? 0))
    db.from('seller_accounts').select('id').eq('user_id', userId).maybeSingle().then(({ data }) => setIsSeller(Boolean(data)))
    db.rpc('am_i_admin').then(({ data }) => setIsAdmin(Boolean(data)))
  }, [userId])

  if (!session) {
    return (
      <div className="stack-lg">
        <div className="card welcome">
          <BowlArt className="welcome-art" />
          <h1>Welcome to Bite<span style={{ color: 'var(--yellow)' }}>BY</span></h1>
          <p className="muted">Sign in to place orders, follow them live, and save your favourite dishes and cooks.</p>
          <a className="button block" href="/signin?mode=signup" onClick={link('/signin?mode=signup')}>Create an account</a>
          <a className="button secondary block" href="/signin" onClick={link('/signin')}>Sign in</a>
        </div>
        <SellerPromo />
        <div className="menu-tiles">
          <Tile to="/my-allergies" icon="leaf" title="My allergies" sub="Hide and flag dishes" tone="var(--green-soft)" wide />
          <Tile to="/help" icon="help" title="Help and support" sub="How BiteBY works" tone="var(--line)" wide />
        </div>
        <ThemePicker />
        <LegalLinks />
      </div>
    )
  }

  const email = session.user.email ?? ''
  const shown = name || email.split('@')[0]
  const saved = favs ? [...favs].filter((k) => k.startsWith('p:')).length : 0
  const sellers = favs ? [...favs].filter((k) => k.startsWith('s:')).length : 0

  return (
    <div className="stack-lg">
      <div className="profile-head">
        <ProfilePicture userId={session.user.id} name={shown} />
        <div style={{ minWidth: 0, flex: 1 }}>
          {editing ? (
            <NameForm initial={name ?? ''} onDone={(n) => { setName(n); setEditing(false) }} />
          ) : (
            <>
              <h1 style={{ fontSize: '1.5rem' }}>{shown}</h1>
              <p className="muted small ellipsis">{email}</p>
              <button type="button" className="link" style={{ paddingLeft: 0 }} onClick={() => setEditing(true)}>Edit name</button>
            </>
          )}
        </div>
      </div>

      <div className="stats">
        <a href="/favourites" onClick={link('/favourites')}><strong>{saved}</strong><span className="muted tiny">Saved dishes</span></a>
        <a href="/favourites?tab=sellers" onClick={link('/favourites?tab=sellers')}><strong>{sellers}</strong><span className="muted tiny">Favourite cooks</span></a>
        <a href="/orders" onClick={link('/orders')}><strong>{reviews}</strong><span className="muted tiny">Reviews</span></a>
      </div>

      {isSeller ? (
        <a className="promo small-promo" href="/sell" onClick={link('/sell')}>
          <h2>Your shop</h2>
          <p>Orders, menu, photos, earnings and reviews.</p>
          <span className="button dark">Open seller tools</span>
          <BowlArt />
        </a>
      ) : <SellerPromo />}

      <div className="menu-tiles">
        <Tile to="/favourites" icon="heart" title="Saved dishes" sub="Dishes you've hearted" tone="#fde8e8" />
        <Tile to="/favourites?tab=sellers" icon="store" title="Favourite cooks" sub="Shops you follow" />
        <Tile to="/orders" icon="orders" title="Orders" sub="Track and reorder" tone="var(--green-soft)" />
        <Tile to="/addresses" icon="pin" title="Addresses" sub="For delivery" tone="var(--yellow-soft)" />
        <Tile to="/messages" icon="chat" title="Messages" sub="Questions to cooks" tone="var(--green-soft)" />
        <Tile to="/alerts" icon="bell" title="Notifications" sub="Order updates" tone="var(--line)" />
        <Tile to="/account/password" icon="lock" title="Password" sub="Set or change it" tone="var(--line)" />
        <Tile to="/help" icon="help" title="Help and support" sub="How BiteBY works" tone="var(--line)" />
        <Tile to="/account" icon="shield" title="Your data" sub="Download or delete" tone="var(--line)" />
        <Tile to="/my-allergies" icon="leaf" title="My allergies" sub="Hide and flag dishes" tone="var(--green-soft)" />
        {isAdmin && <Tile to="/admin" icon="shield" title="Admin" sub="BiteBY team tools" tone="var(--yellow)" wide />}
        <Tile icon="logout" title="Sign out" tone="var(--line)" wide onClick={async () => { await supabase!.auth.signOut(); navigate('/') }} />
      </div>
      <ThemePicker />
      <LegalLinks />
    </div>
  )
}

// Your round profile picture: tap to add or change it, then crop.
function ProfilePicture({ userId, name }: { userId: string; name: string }) {
  const path = useMyAvatar(userId)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')

  async function save(blob: Blob) {
    setFile(null)
    setBusy(true)
    setError('')
    try {
      const next = await uploadPhoto(userId, blob)
      const { error: err } = await supabase!.from('profiles').update({ avatar_path: next }).eq('id', userId)
      if (err) {
        await deletePhoto(next)
        throw new Error(err.message)
      }
      if (path) await deletePhoto(path)
      setMyAvatar(userId, next)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function removePicture() {
    setMenu(false)
    if (!path) return
    const { error: err } = await supabase!.from('profiles').update({ avatar_path: null }).eq('id', userId)
    if (err) return setError(err.message)
    await deletePhoto(path)
    setMyAvatar(userId, null)
  }

  return (
    <div className="profile-pic">
      <label className="profile-pic-btn" aria-label={path ? 'Change your profile picture' : 'Add a profile picture'}>
        <Avatar name={name} path={path} />
        <span className="profile-pic-badge" aria-hidden="true">{busy ? '…' : <Icon name="edit" size={14} />}</span>
        <input type="file" accept="image/*" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = '' }} />
      </label>
      {path && !busy && (
        <button type="button" className="link tiny" onClick={() => (menu ? removePicture() : setMenu(true))}>{menu ? 'Tap again to remove' : 'Remove photo'}</button>
      )}
      {error && <p className="error tiny">{error}</p>}
      {file && (
        <ImageCropper file={file} aspect={1} round width={400} title="Profile picture" hint="Fit your face inside the circle."
          onCancel={() => setFile(null)} onDone={save} />
      )}
    </div>
  )
}

function LegalLinks() {
  return (
    <p className="muted small" style={{ textAlign: 'center' }}>
      <a href="/terms" onClick={link('/terms')}>Terms</a> · <a href="/privacy" onClick={link('/privacy')}>Privacy</a> · <a href="/allergens" onClick={link('/allergens')}>Allergens</a>
    </p>
  )
}

function SellerPromo() {
  const welcome = useWelcomeHeadline()
  const detail = useWelcomeDetail()
  return (
    <section className="promo">
      {welcome && <OfferBadge text={welcome} />}
      <h2>Open your food shop on BiteBY</h2>
      <p>Sell your homemade food to people nearby. {detail}</p>
      <a className="button dark" href="/sell" onClick={link('/sell')}>Become a seller</a>
      <BowlArt />
    </section>
  )
}

function NameForm({ initial, onDone }: { initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial)
  const [message, setMessage] = useState('')
  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const { data: user } = await supabase!.auth.getUser()
    const { error } = await supabase!.from('profiles').update({ display_name: value.trim() || null }).eq('id', user.user!.id)
    if (error) setMessage(error.message)
    else onDone(value.trim())
  }
  return (
    <form className="stack" style={{ gap: 8 }} onSubmit={onSubmit}>
      <input autoFocus maxLength={80} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your name" aria-label="Your name" />
      <div className="row"><button type="submit" className="small-btn">Save</button><button type="button" className="secondary small-btn" onClick={() => onDone(initial)}>Cancel</button></div>
      {message && <p className="error small">{message}</p>}
    </form>
  )
}

export function Help() {
  const commission = useCommission()
  const welcome = useWelcomeOffer()
  const items: [string, string][] = [
    ['How does ordering work?', 'Choose dishes from one cook, then pick delivery or collection. You pay when you order, and the cook accepts and starts cooking. You can follow every step under Orders.'],
    ['What if the cook can’t take my order?', 'If they decline, or don’t answer in time, the order is cancelled and you get your money back in full, including the service fee.'],
    ['What is the service fee?', 'A small fee on each order (1.5% of the order plus about 20p, so 51p on a £20 order) that covers secure card payment and your money-back guarantee. It’s the same however you pay, and you always see it before you pay. The cook gets their full menu price minus BiteBY’s share.'],
    ['Where do I collect from?', 'Cooks’ home addresses are private. You see the collection address only after the cook accepts your order.'],
    ['I have an allergy', 'Every dish lists the 14 main allergens. Food is made in home kitchens, so if your allergy is severe, check with the cook before ordering.'],
    ['Who are the cooks?', 'Local home cooks. Each one registers their food business with their council and is checked by the BiteBY team before their shop can open.'],
    ['Reviews', 'Only people who ordered can leave a review, after the order is complete.'],
    ['What can’t be sold on BiteBY?', 'Alcoholic drinks (they need a licence), cannabis or CBD, raw (unpasteurised) milk, and medicines or supplements. Food cooked with a little alcohol, like rum cake, is fine.'],
    ['Why does BiteBY ask cooks for tax details?', 'HMRC asks online marketplaces to report what each seller earns once a year. Cooks add their date of birth, National Insurance number or UTR, and address. They’re only used for that report and are never shown on a shop.'],
    ['Do cooks need insurance?', 'Yes. Every cook needs public and products liability insurance for the food they sell, and uploads the certificate in their seller account before their shop goes live. Many insurers offer cover for home cooks, often from about £5 to £15 a month. Shops with current insurance show an Insured badge, and a shop is hidden if its insurance runs out.'],
    ['Selling on BiteBY', `Tap Profile, then Become a seller. There’s no sign-up or monthly fee: BiteBY keeps ${commission} of the food price of each order${welcome ? ` (${welcome})` : ''}, and delivery fees are all yours. Card payment costs are paid by the customer as a small service fee, so nothing else comes off. The full breakdown is on the How fees work page, linked from the Sell your food section on the home page.`],
  ]
  return (
    <div className="stack">
      <h1>Help and support</h1>
      {items.map(([q, a]) => (
        <details key={q} className="card">
          <summary>{q}</summary>
          <p className="muted">{a}</p>
        </details>
      ))}
      <h2>Contact the BiteBY team</h2>
      <HelpForm />
      <a href="/help/requests" onClick={link('/help/requests')}>Your messages to BiteBY and our replies</a>
      <LegalLinks />
    </div>
  )
}
