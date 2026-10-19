import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { photoUrl } from '../lib/images'
import { pounds, type Shop } from '../lib/types'
import { canvasBlob, drawShareImage, type ShareSize } from '../lib/shareImage'

type Dish = { id: string; name: string; price_pence: number; portion: string | null; photo: string | null }

// Ready-made pictures of a cook's dishes, with their shop link and QR code,
// to post on Instagram, WhatsApp, TikTok or Facebook.
export default function ShareKit() {
  const [shop, setShop] = useState<Shop | null | undefined>(undefined)
  const [dishes, setDishes] = useState<Dish[]>([])
  const [dishId, setDishId] = useState('')
  const [size, setSize] = useState<ShareSize>('story')
  const [preview, setPreview] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const canvas = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      if (!account) return setShop(null)
      const { data: shops } = await db.from('shops').select('*').eq('seller_account_id', account.id).limit(1)
      const s = (shops?.[0] as Shop | undefined) ?? null
      setShop(s)
      if (!s) return
      const { data: products } = await db.from('products').select('id, name, price_pence, portion, product_images(path, sort)')
        .eq('shop_id', s.id).eq('status', 'published').order('created_at')
      const list: Dish[] = (products ?? []).map((p: { id: string; name: string; price_pence: number; portion: string | null; product_images: { path: string; sort: number }[] | null }) => ({
        id: p.id, name: p.name, price_pence: p.price_pence, portion: p.portion,
        photo: [...(p.product_images ?? [])].sort((a, b) => a.sort - b.sort)[0]?.path ?? null,
      }))
      // Dishes with a photo first: they make the best pictures.
      list.sort((a, b) => Number(!a.photo) - Number(!b.photo))
      setDishes(list)
      setDishId(list[0]?.id ?? '')
    })()
  }, [])

  // The link follows the site's own address, so it changes by itself when BiteBY moves to its final domain.
  const url = shop ? `${window.location.origin}/s/${shop.slug}?ref=share` : ''
  const dish = dishes.find((d) => d.id === dishId)

  useEffect(() => {
    if (!shop || !canvas.current) return
    let stale = false
    const c = canvas.current
    drawShareImage(c, size, {
      shopName: shop.name,
      shopLogo: photoUrl(shop.logo_path),
      dishName: dish?.name ?? shop.name,
      price: dish ? [pounds(dish.price_pence), dish.portion].filter(Boolean).join(' · ') : 'Homemade food near you',
      photo: photoUrl(dish?.photo ?? shop.cover_path),
      url,
    }).then(() => {
      if (stale) return
      try { setPreview(c.toDataURL('image/jpeg', 0.85)) } catch { setPreview('') }
    })
    return () => { stale = true }
  }, [shop, dish, size, url])

  const caption = shop
    ? `${dish ? `${dish.name} from ${shop.name}` : shop.name}, homemade and ready to order 😋 Order here: ${url}`
    : ''
  const fileName = shop ? `${shop.slug}-${dish ? dish.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'shop'}-${size}.png` : 'biteby.png'

  async function shareImage() {
    if (!canvas.current) return
    setBusy(true)
    try {
      const blob = await canvasBlob(canvas.current)
      if (!blob) return
      const file = new File([blob], fileName, { type: 'image/png' })
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: caption }).catch(() => undefined)
      } else download(blob)
    } finally {
      setBusy(false)
    }
  }
  async function save() {
    if (!canvas.current) return
    const blob = await canvasBlob(canvas.current)
    if (blob) download(blob)
  }
  function download(blob: Blob) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fileName
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* not allowed */ }
  }

  if (shop === undefined) return <p className="muted">Loading…</p>
  if (!shop) {
    return (
      <div className="card">
        <p>Set up your shop first, then come back for your share pictures.</p>
        <a className="button" href="/sell/shop" onClick={link('/sell/shop')}>Set up shop</a>
      </div>
    )
  }

  return (
    <div className="stack share-kit">
      <a className="back" href="/sell" onClick={link('/sell')}><Icon name="back" size={18} /> Your shop</a>
      <h1>Share kit</h1>
      <p className="muted">Ready-made pictures of your food with your shop link and QR code. Post them on Instagram, WhatsApp, TikTok or Facebook so people can order straight away.</p>

      <div className="segmented" role="radiogroup" aria-label="Picture size">
        {([['story', 'Story'], ['square', 'Post']] as const).map(([value, label]) => (
          <label key={value} className={size === value ? 'on' : ''}>
            <input type="radio" name="kit-size" checked={size === value} onChange={() => setSize(value)} />
            {label}
          </label>
        ))}
      </div>

      <div className={`kit-preview ${size}`}>
        {preview ? <img src={preview} alt={`${size === 'story' ? 'Story' : 'Post'} picture for ${dish?.name ?? shop.name}`} /> : <span className="muted small">Making your picture…</span>}
      </div>
      <canvas ref={canvas} hidden />

      <button type="button" onClick={shareImage} disabled={!preview || busy}><Icon name="share" size={18} /> Share picture</button>
      <button type="button" className="secondary" onClick={save} disabled={!preview}>Save to phone</button>

      {dishes.length > 1 && (
        <section className="stack">
          <h2>Pick a dish</h2>
          <div className="kit-dishes">
            {dishes.map((d) => {
              const src = photoUrl(d.photo)
              return (
                <button key={d.id} type="button" className={`kit-dish${d.id === dishId ? ' on' : ''}`} onClick={() => setDishId(d.id)} aria-pressed={d.id === dishId}>
                  <span className="kit-thumb">{src ? <img src={src} alt="" loading="lazy" /> : <Icon name="chef" size={22} />}</span>
                  <span className="tiny">{d.name}</span>
                </button>
              )
            })}
          </div>
        </section>
      )}
      {dishes.length === 0 && <p className="status small">Add a dish with a photo under Menu to make pictures of your food. For now your picture uses your shop photo.</p>}

      <section className="card">
        <strong>Caption to go with it</strong>
        <p className="small kit-caption">{caption}</p>
        <button type="button" className="secondary" onClick={copyCaption}>{copied ? 'Copied ✓' : 'Copy caption'}</button>
      </section>

      <section className="card">
        <strong>Tips</strong>
        <ul className="small fee-points">
          <li>Post a story whenever you cook, so followers know what’s fresh today.</li>
          <li>Share in local WhatsApp and Facebook groups, and pin a post to your profile.</li>
          <li>Put your shop link in your Instagram and TikTok bio.</li>
        </ul>
        <a className="button secondary" href="/sell/poster" onClick={link('/sell/poster')}>Print a QR poster</a>
      </section>
    </div>
  )
}
