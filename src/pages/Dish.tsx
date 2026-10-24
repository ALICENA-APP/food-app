import { useEffect, useState, type UIEvent } from 'react'
import { goBack, link, navigate } from '../lib/router'
import { photoUrl } from '../lib/images'
import { Icon, VerifiedTick } from '../lib/icons'
import { lineQty, qtyIn, setQty, useBasket } from '../lib/basket'
import { ReportLink } from '../lib/report'
import { AskCookButton, AskCookTile } from '../lib/askCook'
import { useMyAllergies, warningText } from '../lib/allergies'
import { PopularTag, StockAlertButton, useLovedCounts, useOrderCounts } from '../lib/popular'
import { recordView, rememberDish } from '../lib/views'
import { allergenLists, averageRating, loadShop, type ShopData } from '../lib/shopData'
import { Avatar, BackButton, FoodPhoto, HeartButton, share } from '../lib/ui'
import { daysLabel, dietaryName, noticeLabel, pounds } from '../lib/types'

// One dish: photos, description, ingredients, allergens and add to basket.
export default function Dish({ slug, productId }: { slug: string; productId: string }) {
  const [data, setData] = useState<ShopData | null | undefined>(undefined)
  const [slide, setSlide] = useState(0)
  const [qty, setQtyHere] = useState(1)
  const [added, setAdded] = useState(false)
  const [variantId, setVariantId] = useState<string | null>(null)
  const [addonIds, setAddonIds] = useState<string[]>([])
  const basket = useBasket()
  const counts = useOrderCounts([productId])
  const lovedCounts = useLovedCounts([productId])
  const mine = useMyAllergies()

  useEffect(() => {
    loadShop(slug).then(setData)
    setSlide(0)
    setQtyHere(1)
    setAdded(false)
    setVariantId(null)
    setAddonIds([])
  }, [slug, productId])

  const product = data?.products.find((p) => p.id === productId)

  useEffect(() => {
    if (product && data) {
      document.title = `${product.name} · ${data.shop.name} · BiteBY`
      recordView(data.shop.id, 'dish', product.id)
      rememberDish({ id: product.id, slug: data.shop.slug, name: product.name, shopName: data.shop.name, pricePence: product.price_pence, photo: data.images[product.id]?.[0] ?? null })
    }
    return () => {
      document.title = 'BiteBY · Real food. Real people.'
    }
  }, [product, data])

  if (data === undefined) return <p className="muted">Loading…</p>
  if (!data || !product) {
    return (
      <div className="card empty">
        <span className="big">🍽️</span>
        <h2 style={{ color: 'var(--text)' }}>Dish not found</h2>
        <p>It may have sold out or been taken off the menu.</p>
        <a className="button" href={data ? `/s/${slug}` : '/'} onClick={link(data ? `/s/${slug}` : '/')}>{data ? `See ${data.shop.name}` : 'Back to home'}</a>
      </div>
    )
  }

  const { shop, reviews, categories } = data
  const photos = data.images[product.id] ?? []
  const { contains, mayContain } = allergenLists(data, product.id)
  const average = averageRating(reviews)
  const soldOut = product.stock_qty === 0
  const canOrder = shop.status === 'live' && shop.accepting_orders && product.status === 'published' && !soldOut
  const already = qtyIn(basket, shop.id, product.id)
  const variants = data.variants.filter((v) => v.product_id === product.id)
  const addons = data.addons.filter((a) => a.product_id === product.id)
  const variant = variants.find((v) => v.id === variantId) ?? variants[0] ?? null
  const chosenAddons = addons.filter((a) => addonIds.includes(a.id))
  const unit = Math.max(0, product.price_pence + (variant?.price_delta_pence ?? 0) + chosenAddons.reduce((n, a) => n + a.price_pence, 0))
  const options = [variant?.name, chosenAddons.length ? `+ ${chosenAddons.map((a) => a.name).join(', ')}` : ''].filter(Boolean).join(', ')
  const choice = { productId: product.id, variantId: variant?.id ?? null, addonIds: chosenAddons.map((a) => a.id) }
  const category = categories.find((c) => c.id === product.category_id)?.name
  const myRows = data.rows.filter((r) => r.product_id === product.id && mine.codes.includes(r.allergen_code))
  const myContains = [...new Set(myRows.filter((r) => r.presence === 'contains').map((r) => r.allergen_code))]
  const myMay = [...new Set(myRows.filter((r) => r.presence === 'may_contain').map((r) => r.allergen_code))].filter((c) => !myContains.includes(c))
  const customerPhotos = reviews.filter((r) => r.photo_path && (r.loved_products ?? []).includes(product.id)).slice(0, 10)
  const others = data.products.filter((p) => p.id !== product.id && p.status === 'published').slice(0, 8)

  function onScroll(e: UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    setSlide(Math.round(el.scrollLeft / el.clientWidth))
  }

  function add() {
    const same = lineQty(basket, shop.id, choice)
    const ok = setQty(shop, { ...choice, name: product!.name, options: options || undefined, pricePence: unit, photo: photos[0] ?? null }, same + qty)
    if (ok) setAdded(true)
  }

  return (
    <div className="stack dish-page">
      <div className="dish-hero">
        {photos.length ? (
          <div className="slides" onScroll={onScroll}>
            {photos.map((p) => <img key={p} src={photoUrl(p)!} alt={product.name} />)}
          </div>
        ) : <FoodPhoto path={null} alt="" />}
        <div className="actions">
          <BackButton onClick={() => goBack(`/s/${slug}`)} />
          <span className="group">
            {shop.status === 'live' && <AskCookButton />}
            <button type="button" className="icon-btn" onClick={() => share(product.name)} aria-label="Share this dish"><Icon name="share" /></button>
            <HeartButton productId={product.id} className="icon-btn heart-btn" />
          </span>
        </div>
        {photos.length > 1 && <div className="dots">{photos.map((p, i) => <span key={p} className={i === slide ? 'on' : ''} />)}</div>}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        <div className="item" style={{ alignItems: 'flex-start' }}>
          <h1 style={{ fontSize: '1.5rem' }}>{product.name}</h1>
          <span className="price-big">{variants.length || addons.length ? `from ${pounds(Math.min(...[product.price_pence, ...variants.map((v) => product.price_pence + v.price_delta_pence)]))}` : pounds(product.price_pence)}</span>
        </div>
        <p className="muted small">
          by <a href={`/s/${slug}`} onClick={link(`/s/${slug}`)}><strong>{shop.name}</strong></a>
          {reviews.length > 0 && <> · <span className="star">★</span> {average.toFixed(1)} ({reviews.length})</>}
          {product.portion && <> · {product.portion}</>}
          {product.stock_qty !== null && product.stock_qty > 0 && product.stock_qty <= 5 && <> · Only {product.stock_qty} left</>}
        </p>
        {(myContains.length > 0 || myMay.length > 0) && (
          <p className="allergy-warn" role="alert"><Icon name="info" size={18} /><span><strong>Careful:</strong> this dish {warningText({ contains: myContains, may: myMay })}, which you’ve said you avoid.</span></p>
        )}
        <div className="tags">
          <span className="tag">Homemade</span>
          <PopularTag orders={counts[product.id]} />
          {lovedCounts[product.id] > 0 && <span className="tag loved-tag"><Icon name="heart" size={13} /> Loved by {lovedCounts[product.id]}</span>}
          {daysLabel(product.available_days) && <span className="tag">{daysLabel(product.available_days)}</span>}
          {product.min_lead_hours ? <span className="tag">{noticeLabel(product.min_lead_hours)}</span> : null}
          {category && <span className="tag grey">{category}</span>}
          {product.dietary?.map((d) => <span key={d} className="tag green">{dietaryName(d)}</span>)}
          {product.collection_ok && <span className="tag grey">Collection</span>}
          {product.delivery_ok && <span className="tag grey">Delivery</span>}
        </div>
      </div>

      {product.description && <p className="story">{product.description}</p>}

      {canOrder && variants.length > 0 && (
        <fieldset className="card options">
          <legend>{variants[0].group_name || 'Choose one'} <span className="tag grey">Required</span></legend>
          {variants.map((v) => (
            <label key={v.id} className="option-row">
              <input type="radio" name="variant" checked={variant?.id === v.id} onChange={() => { setVariantId(v.id); setAdded(false) }} />
              <span className="grow">{v.name}</span>
              <span className="muted small">{pounds(product.price_pence + v.price_delta_pence)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {canOrder && addons.length > 0 && (
        <fieldset className="card options">
          <legend>Extras <span className="muted small">optional</span></legend>
          {addons.map((a) => (
            <label key={a.id} className="option-row">
              <input type="checkbox" checked={addonIds.includes(a.id)}
                onChange={(e) => { setAddonIds(e.target.checked ? [...addonIds, a.id] : addonIds.filter((x) => x !== a.id)); setAdded(false) }} />
              <span className="grow">{a.name}</span>
              <span className="muted small">{a.price_pence ? `+ ${pounds(a.price_pence)}` : 'Free'}</span>
            </label>
          ))}
        </fieldset>
      )}

      <a className="card seller-strip" href={`/s/${slug}`} onClick={link(`/s/${slug}`)}>
        <Avatar name={shop.name} path={shop.logo_path} size={48} />
        <span style={{ flex: 1, minWidth: 0 }}>
          <strong>{shop.name}</strong> {shop.status === 'live' && <VerifiedTick />}
          <span className="muted tiny" style={{ display: 'block' }}>{[shop.area_label, ...shop.cuisines].filter(Boolean).join(' · ')}</span>
        </span>
        <span className="button secondary small-btn">View store</span>
      </a>

      <div className="card">
        <div className="info-row">
          <span className="ic"><Icon name="leaf" /></span>
          <div>
            <strong>Ingredients</strong>
            <p className="muted small">{product.ingredients || 'Ask the cook for the full ingredients.'}</p>
          </div>
        </div>
        <div className="info-row">
          <span className="ic" style={{ background: contains.length ? '#fde8e8' : 'var(--green-soft)' }}><Icon name="info" /></span>
          <div className="stack" style={{ gap: 4 }}>
            <strong>Allergens</strong>
            <p className="small"><strong>Contains:</strong> {contains.length ? contains.join(', ') : 'none of the 14 main allergens'}</p>
            {mayContain.length > 0 && <p className="small"><strong>May contain:</strong> {mayContain.join(', ')}</p>}
            {product.may_contain_notes && <p className="muted small">{product.may_contain_notes}</p>}
            <p className="muted tiny">Made in a home kitchen. If you have a severe allergy, message the cook before ordering.</p>
          </div>
        </div>
      </div>

      {customerPhotos.length > 0 && (
        <section className="stack" style={{ gap: 8 }}>
          <h2>Photos from customers</h2>
          <div className="customer-photos">
            {customerPhotos.map((r) => <img key={r.id} src={photoUrl(r.photo_path)!} alt={`${product.name}, photo from ${r.reviewer_name}`} loading="lazy" />)}
          </div>
        </section>
      )}

      {shop.status === 'live' && <AskCookTile shopId={shop.id} cookName={shop.name} productId={product.id} productName={product.name} />}
      {shop.status === 'live' && <ReportLink shopId={shop.id} productId={product.id} />}

      {others.length > 0 && (
        <section className="stack">
          <h2>You might also like</h2>
          <div className="hscroll">
            {others.map((p) => {
              const to = `/s/${slug}/i/${p.id}`
              return (
                <a key={p.id} className="dish-card small" href={to} onClick={link(to)}>
                  <span className="ph"><FoodPhoto path={data.images[p.id]?.[0] ?? null} alt={p.name} /></span>
                  <span className="body"><span className="name">{p.name}</span><span className="price">{pounds(p.price_pence)}</span></span>
                </a>
              )
            })}
          </div>
        </section>
      )}

      {canOrder ? (
        <div className="card action-bar row-bar">
          {added ? (
            <>
              <span className="tick"><Icon name="check" size={20} /> Added to basket</span>
              <button type="button" className="dark" onClick={() => navigate('/basket')}>View basket</button>
            </>
          ) : (
            <>
              <span className="stepper">
                <button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => setQtyHere(qty - 1)}>−</button>
                <span>{qty}</span>
                <button type="button" className="add" aria-label="One more" onClick={() => setQtyHere(Math.max(1, Math.min(qty + 1, 50, (product.stock_qty ?? 50) - already)))}>+</button>
              </span>
              <button type="button" className="grow" onClick={add}>Add to basket · {pounds(unit * qty)}</button>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="status">{shop.status !== 'live' ? 'Preview: customers can order once your shop is live.' : soldOut ? 'Sold out for now.' : "This dish can't be ordered right now."}</p>
          {shop.status === 'live' && soldOut && <StockAlertButton productId={product.id} />}
        </>
      )}
    </div>
  )
}
