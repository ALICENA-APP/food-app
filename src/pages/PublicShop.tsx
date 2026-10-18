import { Fragment, useEffect, useState } from 'react'
import { goBack, link, navigate } from '../lib/router'
import { recordView } from '../lib/views'
import { ShopOffers } from '../lib/discounts'
import { ReportLink } from '../lib/report'
import { AskCookButton, AskCookTile } from '../lib/askCook'
import { CateringTile, fsaLink, hygieneWords, useHygiene } from '../lib/hygiene'
import { supabase } from '../lib/supabase'
import { useLovedCounts, useOrderCounts } from '../lib/popular'
import { CategoryIcon } from '../lib/categoryIcons'
import { freeFrom, useAllergenHits, useMyAllergies } from '../lib/allergies'
import { photoUrl } from '../lib/images'
import { Icon, VerifiedTick } from '../lib/icons'
import { ReviewItem } from '../lib/reviews'
import { basketCount, basketSubtotal, qtyIn, setQty, useBasket } from '../lib/basket'
import { averageRating, hasOptions, hoursSummary, loadShop, type ShopData } from '../lib/shopData'
import { awayUntil, londonNow, openState, shortDate } from '../lib/hours'
import { Avatar, BackButton, FoodPhoto, HeartButton, share } from '../lib/ui'
import { daysLabel, dietaryName, noticeLabel, pounds, type Product } from '../lib/types'

// The shareable shop page at /s/<slug>. Visitors see live shops only; the
// owner can also preview their own shop before it goes live.
export default function PublicShop({ slug }: { slug: string }) {
  const [data, setData] = useState<ShopData | null | undefined>(undefined)
  const [tab, setTab] = useState<'menu' | 'reviews' | 'about'>('menu')
  const [category, setCategory] = useState('')
  const basket = useBasket()
  const counts = useOrderCounts(data?.products.map((p) => p.id) ?? [])
  const loved = useLovedCounts(data?.products.map((p) => p.id) ?? [])
  const [fullToday, setFullToday] = useState(false)
  const mine = useMyAllergies()
  const allergyHits = useAllergenHits(data?.products.map((p) => p.id) ?? [], mine.codes)
  const [showAll, setShowAll] = useState(false)
  const hygiene = useHygiene(data ? [data.shop.id] : [])

  useEffect(() => {
    loadShop(slug).then(setData)
  }, [slug])

  useEffect(() => {
    if (!data?.shop.id) return
    supabase!.rpc('shop_full_days', { p_shop: data.shop.id }).then(({ data: days }) => {
      setFullToday(((days ?? []) as string[]).map(String).includes(londonNow().date))
    })
  }, [data?.shop.id])

  useEffect(() => {
    if (data) {
      document.title = `${data.shop.name} · BiteBY`
      recordView(data.shop.id, 'shop')
    }
    return () => {
      document.title = 'BiteBY · Real food. Real people.'
    }
  }, [data])

  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) {
    return (
      <div className="card empty">
        <span className="big">🏠</span>
        <h2 style={{ color: 'var(--text)' }}>Shop not found</h2>
        <p>This shop doesn't exist or isn't open yet.</p>
        <a className="button" href="/" onClick={link('/')}>Back to home</a>
      </div>
    )
  }

  const { shop, settings, products, images, hours, closedDates, awayReason, reviews, categories } = data
  const average = averageRating(reviews)
  const isPreview = shop.status !== 'live'
  const canOrder = !isPreview && shop.accepting_orders
  const usedCategories = categories.filter((c) => products.some((p) => p.category_id === c.id))
  const inCategory = products.filter((p) => !category || p.category_id === category)
  const shown = showAll ? inCategory : inCategory.filter((p) => freeFrom(allergyHits, p.id, mine.strict))
  const hidden = inCategory.length - inCategory.filter((p) => freeFrom(allergyHits, p.id, mine.strict)).length
  const options = [settings?.offers_delivery && 'Delivery', settings?.offers_collection && 'Collection'].filter(Boolean) as string[]
  const inBasket = basket?.shopId === shop.id ? basketCount(basket) : 0
  const state = openState(hours, closedDates)
  const back = awayUntil(closedDates)
  // Popular dishes first, most ordered at the top.
  const popularFirst = shown.filter((p) => counts[p.id] && p.stock_qty !== 0).sort((a, b) => counts[b.id] - counts[a.id])
  const rest = shown.filter((p) => !popularFirst.includes(p))

  return (
    <div className="stack">
      <div className="store-hero">
        {shop.cover_path ? <img src={photoUrl(shop.cover_path)!} alt="" /> : <span className="placeholder-food" style={{ fontSize: '4rem' }}>🍲</span>}
        <div className="actions">
          <BackButton onClick={() => goBack('/')} />
          <span className="group">
            {!isPreview && <AskCookButton />}
            <button type="button" className="icon-btn" onClick={() => share(shop.name)} aria-label="Share this shop"><Icon name="share" /></button>
            <HeartButton shopId={shop.id} className="icon-btn heart-btn" />
          </span>
        </div>
      </div>

      <div className="store-card compact">
        <div className="store-id">
          <Avatar name={shop.name} path={shop.logo_path} />
          <div className="who">
            <h1>{shop.name} {!isPreview && <VerifiedTick />}</h1>
            <p className="meta">
              {reviews.length > 0 && <button type="button" className="link-plain" onClick={() => setTab('reviews')}><span className="star">★</span> <strong>{average.toFixed(1)}</strong> ({reviews.length})</button>}
              {reviews.length > 0 && shop.area_label && ' · '}
              {shop.area_label && <span><Icon name="pin" size={14} /> {shop.area_label}</span>}
            </p>
            {(shop.story || shop.cuisines.length > 0) && <p className="tagline">{shop.story?.split('\n')[0] || shop.cuisines.join(' · ')}</p>}
          </div>
        </div>

        <div className="trust-chips">
          {state && <span className={state.open ? 'open' : ''}><Icon name="clock" size={16} />{state.label.replace('Open now · until', 'Open until').replace('Closed today · opens', 'Opens')}</span>}
          {settings?.offers_delivery && <span><Icon name="truck" size={16} />Delivery {settings.radius_fee_pence ? pounds(settings.radius_fee_pence) : 'free'}</span>}
          {settings?.offers_collection && <span><Icon name="bag" size={16} />Pick-up</span>}
          {hygiene[shop.id] && <button type="button" onClick={() => setTab('about')}><span className="fhrs">{hygiene[shop.id].rating}</span>Hygiene {hygieneWords(hygiene[shop.id].rating).toLowerCase().replace(' necessary', '')}</button>}
          {!isPreview && <span><Icon name="shield" size={16} />Checked cook</span>}
          {(settings?.min_order_pence ?? 0) > 0 && <span><Icon name="pound" size={16} />Min {pounds(settings!.min_order_pence)}</span>}
        </div>

        {!isPreview && <ShopOffers shopId={shop.id} />}
      </div>

      {isPreview && <p className="status small">Preview: only you can see this until your shop goes live.</p>}
      {shop.is_demo && <p className="demo-banner small"><strong>Demo shop.</strong> Made up to show how BiteBY works, so it can’t take real orders.</p>}
      {shop.notice && (!shop.notice_until || shop.notice_until >= londonNow().date) && (
        <p className="shop-notice"><Icon name="info" size={18} /> <span>{shop.notice}</span></p>
      )}
      {back && (
        <p className="away-note small">
          <strong>{shop.name} is away{awayReason ? ` (${awayReason})` : ''}.</strong> Back on {shortDate(back)}.{canOrder && ' You can order ahead for then at checkout.'}
        </p>
      )}
      {!isPreview && !shop.accepting_orders && <p className="status small">This shop isn't taking orders right now.</p>}
      {canOrder && fullToday && !back && <p className="status small">Fully booked today. You can still order for another day at checkout.</p>}

      <div className="tabs compact" role="tablist">
        {(['menu', 'reviews', 'about'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            <Icon name={t === 'menu' ? 'cutlery' : t === 'reviews' ? 'star' : 'info'} size={16} />
            {t === 'menu' ? 'Menu' : t === 'reviews' ? `Reviews${reviews.length ? ` ${reviews.length}` : ''}` : 'Info'}
          </button>
        ))}
      </div>

      {tab === 'menu' && (
        <>
          {usedCategories.length > 1 && (
            <div className="chips">
              <button type="button" className={`chip icon-chip ${!category ? 'on' : ''}`} onClick={() => setCategory('')}><Icon name="cutlery" size={16} /> All</button>
              {usedCategories.map((c) => (
                <button key={c.id} type="button" className={`chip icon-chip ${category === c.id ? 'on' : ''}`} onClick={() => setCategory(c.id)}>
                  <span className="mini-cat"><CategoryIcon slug={c.slug} /></span> {c.name}
                </button>
              ))}
            </div>
          )}
          {hidden > 0 && (
            <p className="muted small">
              {showAll ? 'Showing every dish, including ones with your allergens.' : `${hidden} ${hidden === 1 ? 'dish is' : 'dishes are'} hidden because of your allergies.`}{' '}
              <button type="button" className="link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Hide them' : 'Show anyway'}</button>
            </p>
          )}
          {shown.length === 0 && hidden === 0 && <p className="muted">Nothing on the menu yet.</p>}
          {popularFirst.length > 0 && rest.length > 0 && <h2 className="menu-head">Popular dishes</h2>}
          {[...popularFirst, ...rest].map((p, i) => {
            // Dishes with sizes or extras open their page to choose first.
            const choose = hasOptions(data, p.id)
            const from = Math.min(p.price_pence, ...data.variants.filter((v) => v.product_id === p.id).map((v) => p.price_pence + v.price_delta_pence))
            return (
              <Fragment key={p.id}>
              {i === popularFirst.length && popularFirst.length > 0 && <h2 className="menu-head">More dishes</h2>}
              <MenuRow loved={loved[p.id]} orders={counts[p.id]} product={p} slug={shop.slug} photo={images[p.id]?.[0] ?? null} price={choose ? `from ${pounds(from)}` : pounds(p.price_pence)}
                qty={choose ? 0 : qtyIn(basket, shop.id, p.id)} canOrder={canOrder && p.status === 'published' && p.stock_qty !== 0}
                onQty={(n) => (choose ? navigate(`/s/${shop.slug}/i/${p.id}`)
                  : setQty(shop, { productId: p.id, name: p.name, pricePence: p.price_pence, photo: images[p.id]?.[0] ?? null }, n))} />
              </Fragment>
            )
          })}
          <p className="muted tiny"><Icon name="info" size={14} /> Allergies? Tap a dish for its ingredients and allergens, or ask the cook before ordering.</p>
        </>
      )}

      {tab === 'reviews' && (
        <div className="card">
          {reviews.length === 0 ? <p className="muted">No reviews yet. Reviews come only from people who ordered.</p>
            : reviews.map((r) => <ReviewItem key={r.id} review={r} dishNames={Object.fromEntries(products.map((p) => [p.id, p.name]))} />)}
        </div>
      )}

      {tab === 'about' && (
        <div className="card">
          {shop.story && <p className="story">{shop.story}</p>}
          {hours.length > 0 && (
            <div className="info-row"><span className="ic"><Icon name="clock" /></span><div><strong>Opening hours</strong><p className="muted small">{hoursSummary(hours)}</p></div></div>
          )}
          {options.length > 0 && (
            <div className="info-row"><span className="ic"><Icon name={settings?.offers_delivery ? 'truck' : 'bag'} /></span><div><strong>{options.join(' and ')}</strong>
              <p className="muted small">{settings?.offers_collection ? "You'll get the collection address once the cook accepts your order." : 'The cook delivers to nearby postcodes.'}</p></div></div>
          )}
          {!isPreview && (
            <div className="info-row"><span className="ic"><Icon name="shield" /></span><div><strong>Checked by BiteBY</strong><p className="muted small">This cook has registered with their local council and been approved by our team.</p></div></div>
          )}
          {hygiene[shop.id] && (
            <div className="info-row"><span className="ic"><Icon name="check" /></span><div><strong>Food hygiene rating {hygiene[shop.id].rating}: {hygieneWords(hygiene[shop.id].rating).toLowerCase()}</strong>
              <p className="muted small">
                From the local council{hygiene[shop.id].rating_date ? `, inspected ${new Date(hygiene[shop.id].rating_date + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}` : ''}. Checked by BiteBY.
                {hygiene[shop.id].fhrs_id && <> <a href={fsaLink(hygiene[shop.id].fhrs_id!)} target="_blank" rel="noopener noreferrer">See it on the FSA website</a></>}
              </p></div></div>
          )}
        </div>
      )}

      {!isPreview && (
        <div className="shop-extras">
          {settings?.takes_catering && <CateringTile shopId={shop.id} cookName={shop.name} />}
          <AskCookTile shopId={shop.id} cookName={shop.name} />
          <ReportLink shopId={shop.id} />
        </div>
      )}

      {inBasket > 0 && (
        <a className="button dark basket-bar" href="/basket" onClick={link('/basket')}>
          <Icon name="basket" size={20} /> View basket · {inBasket} {inBasket === 1 ? 'item' : 'items'} · {pounds(basketSubtotal(basket))}
        </a>
      )}
    </div>
  )
}

function MenuRow({ product: p, orders, loved, slug, photo, price, qty, canOrder, onQty }: {
  product: Product; orders?: number; loved?: number; slug: string; photo: string | null; price: string; qty: number; canOrder: boolean; onQty: (n: number) => void
}) {
  const to = `/s/${slug}/i/${p.id}`
  // One short line of extra details.
  const extra = [
    ...(p.dietary ?? []).map(dietaryName),
    daysLabel(p.available_days),
    p.min_lead_hours ? noticeLabel(p.min_lead_hours) : '',
    p.stock_qty !== null && p.stock_qty > 0 && p.stock_qty <= 5 ? `Only ${p.stock_qty} left` : '',
  ].filter(Boolean).join(' · ')
  return (
    <a className={`dish-row ${p.stock_qty === 0 ? 'sold-out' : ''}`} href={to} onClick={link(to)}>
      <span className="ph"><FoodPhoto path={photo} alt={p.name} /></span>
      <span className="info">
        <strong className="name">{p.name}</strong>
        {p.description && <span className="desc">{p.description}</span>}
        <span className="meta">
          {p.stock_qty === 0 ? <span className="tag red">Sold out</span>
            : orders ? <span className="hot"><Icon name="star" size={14} /> Popular</span> : null}
          {loved ? <span className="loved"><Icon name="heart" size={13} /> {loved}</span> : null}
        </span>
        {extra && <span className="muted tiny">{extra}</span>}
        {p.status !== 'published' && <span className="pill">Draft, not visible to customers</span>}
      </span>
      <span className="side" onClick={canOrder ? (e) => { e.preventDefault(); e.stopPropagation() } : undefined}>
        <strong className="price">{price}</strong>
        {canOrder && (qty > 0 ? (
          <span className="stepper">
            <button type="button" aria-label="One less" onClick={() => onQty(qty - 1)}>−</button>
            <span>{qty}</span>
            <button type="button" className="add" aria-label="One more" onClick={() => onQty(qty + 1)}>+</button>
          </span>
        ) : (
          <button type="button" className="plus" aria-label={`Add ${p.name}`} onClick={() => onQty(1)}>+</button>
        ))}
      </span>
    </a>
  )
}
