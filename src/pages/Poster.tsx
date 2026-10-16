import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { myUserId } from '../lib/session'
import { link } from '../lib/router'
import { Icon } from '../lib/icons'
import { Wordmark } from '../lib/ui'
import type { Shop } from '../lib/types'

// A printable poster and QR code for the seller's shop link: for a
// window, a fridge, a market stall or a WhatsApp group.
export default function Poster() {
  const [shop, setShop] = useState<Shop | null | undefined>(undefined)
  const [svg, setSvg] = useState('')
  const [png, setPng] = useState('')

  useEffect(() => {
    ;(async () => {
      const db = supabase!
      const { data: account } = await db.from('seller_accounts').select('id').eq('user_id', await myUserId()).maybeSingle()
      if (!account) return setShop(null)
      const { data: shops } = await db.from('shops').select('*').eq('seller_account_id', account.id).limit(1)
      setShop(shops?.[0] ?? null)
    })()
  }, [])

  const url = shop ? `${window.location.origin}/s/${shop.slug}?ref=qr` : ''
  useEffect(() => {
    if (!url) return
    QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }).then(setSvg)
    QRCode.toDataURL(url, { width: 1024, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#111111', light: '#ffffff' } }).then(setPng)
  }, [url])

  if (shop === undefined) return <p className="muted">Loading…</p>
  if (!shop) {
    return (
      <div className="card">
        <p>Set up your shop first, then come back for your poster.</p>
        <a className="button" href="/sell/shop" onClick={link('/sell/shop')}>Set up shop</a>
      </div>
    )
  }

  const shortUrl = `${window.location.host}/s/${shop.slug}`
  return (
    <div className="stack">
      <div className="no-print stack">
        <a className="back" href="/sell" onClick={link('/sell')}><Icon name="back" size={18} /> Your shop</a>
        <h1>Your shop poster</h1>
        <p className="muted">Print it for your window, fridge or stall. People scan the code with their phone camera and land on your menu.</p>
        <div className="row">
          <button type="button" onClick={() => window.print()}>Print or save as PDF</button>
          {png && <a className="button secondary" href={png} download={`${shop.slug}-qr.png`}>Download QR code</a>}
        </div>
        {shop.status !== 'live' && <p className="status small">Your shop isn’t live yet. The code works now, and shows your menu as a preview until you’re approved.</p>}
      </div>

      <article className="poster" aria-label="Poster preview">
        <div className="poster-top"><Wordmark size={40} /></div>
        <p className="poster-kicker">Homemade food from</p>
        <h2 className="poster-name">{shop.name}</h2>
        {(shop.area_label || shop.cuisines.length > 0) && (
          <p className="poster-sub">{[shop.cuisines.slice(0, 3).join(' · '), shop.area_label].filter(Boolean).join(' · ')}</p>
        )}
        <div className="poster-qr" dangerouslySetInnerHTML={{ __html: svg }} />
        <p className="poster-cta">Scan to see the menu and order</p>
        <p className="poster-url">{shortUrl}</p>
        <p className="poster-foot">Real food. Real people.</p>
      </article>
    </div>
  )
}
