// Adds a proper preview card (name, description, photo) to shared links:
// /s/<slug> for a shop, /s/<slug>/i/<id> for one dish and /near/<town> for a
// town page, so links on WhatsApp, Facebook, etc. look good and Google can
// read them (with structured data for shops and dishes). Only live shops and
// dishes on sale are found (the public key can't read anything else). Demo
// shops are kept out of Google.
import type { Config, Context } from '@netlify/edge-functions'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Preview = { title: string; description: string; image: string | null; data?: object; noindex?: boolean }

async function query(base: string, key: string, path: string, body?: object) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'food', 'content-profile': 'food', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2500),
  })
  const rows = res.ok ? await res.json() : []
  return Array.isArray(rows) ? rows[0] : rows
}

const photoUrl = (base: string, path: string | null) =>
  path && !path.startsWith('/') ? `${base}/storage/v1/object/public/product-images/${path}` : null

async function shopPreview(base: string, key: string, slug: string, url: string): Promise<Preview | null> {
  const shop = await query(base, key, `shops?slug=eq.${slug}&status=eq.live&select=name,story,area_label,cuisines,cover_path,is_demo&limit=1`)
  if (!shop) return null
  const where = [shop.area_label, ...(shop.cuisines ?? [])].filter(Boolean).join(' · ')
  const image = photoUrl(base, shop.cover_path)
  const town = (shop.area_label ?? '').split(',')[0].trim()
  return {
    title: `${shop.name} · Homemade food${town ? ` in ${town}` : ''} · BiteBY`,
    description: (shop.story || `Homemade food on BiteBY${where ? ` · ${where}` : ''}. Order online.`).slice(0, 200),
    image,
    noindex: shop.is_demo,
    data: {
      '@context': 'https://schema.org', '@type': 'FoodEstablishment', name: shop.name, url,
      description: shop.story ?? undefined, image: image ?? undefined,
      servesCuisine: shop.cuisines?.length ? shop.cuisines : undefined,
      address: town ? { '@type': 'PostalAddress', addressLocality: town, addressCountry: 'GB' } : undefined,
      priceRange: '££',
    },
  }
}

async function dishPreview(base: string, key: string, slug: string, id: string, url: string): Promise<Preview | null> {
  const dish = await query(base, key,
    `products?id=eq.${id}&status=eq.published&shops.slug=eq.${slug}&select=name,description,price_pence,shops!inner(name,slug,cover_path,is_demo),product_images(path,sort)&limit=1`)
  if (!dish) return null
  const price = `£${(dish.price_pence / 100).toFixed(2)}`
  const first = [...(dish.product_images ?? [])].sort((a: { sort: number }, b: { sort: number }) => a.sort - b.sort)[0]?.path
  // Some apps can't show WebP previews, so the shop's JPEG cover is preferred over a WebP dish photo.
  const photo = first && !first.endsWith('.webp') ? first : dish.shops.cover_path || first
  const image = photoUrl(base, photo)
  return {
    title: `${dish.name} · ${price} · ${dish.shops.name}`,
    description: (dish.description || `Homemade by ${dish.shops.name}. Order on BiteBY.`).slice(0, 200),
    image,
    noindex: dish.shops.is_demo,
    data: {
      '@context': 'https://schema.org', '@type': 'Product', name: dish.name, url,
      description: dish.description ?? undefined, image: image ?? undefined,
      brand: { '@type': 'Brand', name: dish.shops.name },
      offers: { '@type': 'Offer', price: (dish.price_pence / 100).toFixed(2), priceCurrency: 'GBP', availability: 'https://schema.org/InStock', url },
    },
  }
}

async function townPreview(base: string, key: string, slug: string): Promise<Preview | null> {
  const towns: { slug: string; town: string; shops: number; real_shops: number }[] =
    await fetch(`${base}/rest/v1/rpc/towns`, {
      method: 'POST',
      headers: { apikey: key, authorization: `Bearer ${key}`, 'content-profile': 'food', 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(2500),
    }).then((r) => (r.ok ? r.json() : []))
  const t = towns.find((x) => x.slug === slug)
  if (!t) return null
  const n = t.shops === 1 ? '1 local cook' : `${t.shops} local cooks`
  return {
    title: `Homemade food in ${t.town} · BiteBY`,
    description: `Order homemade food from ${n} in ${t.town}. Real food from real people, for collection or delivery.`,
    image: null,
    noindex: t.real_shops === 0,
  }
}

export default async (request: Request, context: Context) => {
  const response = await context.next()
  const url = new URL(request.url)
  const [, section, slug, kind, id] = url.pathname.split('/')
  const base = Netlify.env.get('VITE_SUPABASE_URL')
  const key = Netlify.env.get('VITE_SUPABASE_ANON_KEY')
  if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug) || !base || !key) return response
  const isTown = section === 'near'
  const isDish = !isTown && kind === 'i' && /^[0-9a-f-]{36}$/.test(id ?? '')
  if (kind && !isDish) return response
  const canonical = `${url.origin}${url.pathname.replace(/\/$/, '')}`

  try {
    const preview = isTown ? await townPreview(base, key, slug)
      : isDish ? await dishPreview(base, key, slug, id, canonical) : await shopPreview(base, key, slug, canonical)
    if (!preview) return response
    const { title, description } = preview
    const image = preview.image ?? `${new URL(request.url).origin}/og-image.png`
    const tags = [
      `<title>${escape(title)}</title>`,
      `<meta name="description" content="${escape(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="BiteBY" />`,
      `<meta property="og:title" content="${escape(title)}" />`,
      `<meta property="og:description" content="${escape(description)}" />`,
      `<meta property="og:url" content="${escape(canonical)}" />`,
      image ? `<meta property="og:image" content="${escape(image)}" />` : '',
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
      `<link rel="canonical" href="${escape(canonical)}" />`,
      preview.noindex ? '<meta name="robots" content="noindex" />' : '',
      preview.data ? `<script type="application/ld+json">${JSON.stringify(preview.data).replace(/</g, '\\u003c')}</script>` : '',
    ].filter(Boolean).join('\n    ')

    const html = await response.text()
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    const page = html
      .replace(/\s*<meta (?:property="og:[^"]*"|name="description")[^>]*>/g, '')
      .replace(/<title>[^<]*<\/title>/, tags)
    return new Response(page, { status: response.status, headers })
  } catch {
    return response
  }
}

export const config: Config = { path: ['/s/*', '/s/*/i/*', '/near/*'] }
