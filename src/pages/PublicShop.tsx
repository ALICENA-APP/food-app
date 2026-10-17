import { useEffect, useState } from 'react'
import { goBack, link, navigate } from '../lib/router'
import { recordView } from '../lib/views'
import { ShopOffers } from '../lib/discounts'
import { ReportLink } from '../lib/report'
import { AskCookTile } from '../lib/askCook'
import { supabase } from '../lib/supabase'
import { useOrderCounts } from '../lib/popular'
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
  const [fullToday, setFullToday] = useState(false)
  const mine = useMyAllergies()
  const allergyHits = useAllergenHits(data?.products.map((p) => p.id) ?? [], mine.codes)
  const [showAll, setShowAll] = useState(false)

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

  return (
    <div className="stack">
      <div className="store-hero">
        {shop.cover_path ? <img src={photoUrl(shop.cover_path)!} alt="" /> : <span className="placeholder-food" style={{ fontSize: '4rem' }}>🍲</span>}
        <div className="actions">
          <BackButton onClick={() => goBack('/')} />
          <span className="group">
            <button type="button" className="icon-btn" onClick={() => share(shop.name)} aria-label="Share this shop"><Icon name="share" /></button>
            <HeartButton shopId={shop.id} className="icon-btn heart-btn" />
          </span>
        </div>
      </div>

      <div className="store-card">
        <div className="head">
          <Avatar name={shop.name} path={shop.logo_path} />
        </div>
        <h1>{shop.name} {!isPreview && <VerifiedTick />}</h1>
        <p className="muted small meta">
          {reviews.length > 0 && <><span className="star">★</span> <strong>{average.toFixed(1)}</strong> ({reviews.length} {reviews.length === 1 ? 'review' : 'reviews'}) · </>}
          {shop.area_label && <><Icon name="pin" size={15} /> {shop.area_label}</>}
        </p>
        {state && <span className={`pill ${state.open ? 'green' : ''}`}>{state.label}</span>}
        {shop.story && <p className="story clamp3">{shop.story}</p>}
        <div className="tags">
          {shop.cuisines.map((c) => <span key={c} className="tag">{c}</span>)}
          {options.map((o) => <span key={o} className="tag grey">{o}</span>)}
        </div>
      </div>

      {isPreview && <p className="status">Preview: only you can see this until your shop goes live.</p>}
      {shop.is_demo && <p className="demo-banner small"><strong>This is a demo shop.</strong> It’s made up to show how BiteBY works, so it can’t take real orders.</p>}
      {shop.notice && (!shop.notice_until || shop.notice_until >= londonNow().date) && (
        <p className="shop-notice"><Icon name="info" size={18} /> <span>{shop.notice}</span></p>
      )}
      {!isPreview && <ShopOffers shopId={shop.id} />}
      {back ? (
        <p className="away-note small">
          <strong>{shop.name} is away{awayReason ? ` (${awayReason})` : ''}.</strong> Back on {shortDate(back)}.{canOrder && ' You can order ahead for then at checkout.'}
        </p>
      ) : state && !state.open && canOrder && <p className="status small">You can still order ahead: choose a time at checkout.</p>}
      {!isPreview && !shop.accepting_orders && <p className="status">This shop isn't taking orders right now.</p>}
      {canOrder && fullToday && !back && <p className="status small">Fully booked today. You can still order for another day: choose a time at checkout.</p>}

      <div className="tabs" role="tablist">
        {(['menu', 'reviews', 'about'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'menu' ? 'Menu' : t === 'reviews' ? `Reviews${reviews.length ? ` (${reviews.length})` : ''}` : 'About'}
          </button>
        ))}
      </div>

      {tab === 'menu' && (
        <>
          {usedCategories.length > 1 && (
            <div className="chips">
              <button type="button" className={`chip ${!category ? 'on' : ''}`} onClick={() => setCategory('')}>All</button>
              {usedCategories.map((c) => (
                <button key={c.id} type="button" className={`chip ${category === c.id ? 'on' : ''}`} onClick={() => setCategory(c.id)}>{c.name}</button>
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
          {shown.map((p) => {
            // Dishes with sizes or extras open their page to choose first.
            const choose = hasOptions(data, p.id)
            const from = Math.min(p.price_pence, ...data.variants.filter((v) => v.product_id === p.id).map((v) => p.price_pence + v.price_delta_pence))
            return (
              <MenuRow key={p.id} orders={counts[p.id]} product={p} slug={shop.slug} photo={images[p.id]?.[0] ?? null} price={choose ? `from ${pounds(from)}` : pounds(p.price_pence)}
                qty={choose ? 0 : qtyIn(basket, shop.id, p.id)} canOrder={canOrder && p.status === 'published' && p.stock_qty !== 0}
                onQty={(n) => (choose ? navigate(`/s/${shop.slug}/i/${p.id}`)
                  : setQty(shop, { productId: p.id, name: p.name, pricePence: p.price_pence, photo: images[p.id]?.[0] ?? null }, n))} />
            )
          })}
          <p className="muted small">
            Have an allergy? Tap a dish to see its ingredients and allergens, and message the cook before ordering if you're unsure.
          </p>
        </>
      )}

      {tab === 'reviews' && (
        <div className="card">
          {reviews.length === 0 ? <p className="muted">No reviews yet. Reviews come only from people who ordered.</p>
            : reviews.map((r) => <ReviewItem key={r.id} review={r} />)}
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
        </div>
      )}

      {!isPreview && <AskCookTile shopId={shop.id} cookName={shop.name} />}
      {!isPreview && <ReportLink shopId={shop.id} />}

      {inBasket > 0 && (
        <a className="button dark basket-bar" href="/basket" onClick={link('/basket')}>
          <Icon name="basket" size={20} /> View basket · {inBasket} {inBasket === 1 ? 'item' : 'items'} · {pounds(basketSubtotal(basket))}
        </a>
      )}
    </div>
  )
}

function MenuRow({ product: p, orders, slug, photo, price, qty, canOrder, onQty }: {
  product: Product; orders?: number; slug: string; photo: string | null; price: string; qty: number; canOrder: boolean; onQty: (n: number) => void
}) {
  const to = `/s/${slug}/i/${p.id}`
  return (
    <a className={`menu-row ${p.stock_qty === 0 ? 'sold-out' : ''}`} href={to} onClick={link(to)}>
      <span className="ph"><FoodPhoto path={photo} alt={p.name} /></span>
      <span className="info">
        <strong>{p.name}</strong>
        {p.description && <span className="desc">{p.description}</span>}
        {p.dietary?.length > 0 && <span className="tags">{p.dietary.map((d) => <span key={d} className="tag green">{dietaryName(d)}</span>)}</span>}
        {p.status !== 'published' && <span className="pill">Draft, not visible to customers</span>}
        <strong>{price}</strong>
        {p.stock_qty === 0 ? <span className="tag red">Sold out</span> : orders ? <span className="tag popular">Popular</span> : null}
        {daysLabel(p.available_days) && <span className="muted tiny">{daysLabel(p.available_days)}</span>}
        {p.min_lead_hours ? <span className="muted tiny">{noticeLabel(p.min_lead_hours)}</span> : null}
        {p.stock_qty !== null && p.stock_qty > 0 && p.stock_qty <= 5 && <span className="muted tiny">Only {p.stock_qty} left</span>}
      </span>
      {canOrder && (
        <span className="side" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
          {qty > 0 ? (
            <span className="stepper">
              <button type="button" aria-label="One less" onClick={() => onQty(qty - 1)}>−</button>
              <span>{qty}</span>
              <button type="button" className="add" aria-label="One more" onClick={() => onQty(qty + 1)}>+</button>
            </span>
          ) : (
            <button type="button" className="plus" aria-label={`Add ${p.name}`} onClick={() => onQty(1)}>+</button>
          )}
        </span>
      )}
    </a>
  )
}
