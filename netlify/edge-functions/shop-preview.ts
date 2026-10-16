// Adds a proper preview card (name, description, photo) to shared links:
// /s/<slug> for a shop and /s/<slug>/i/<id> for one dish, so links on
// WhatsApp, Facebook, etc. look good. Only live shops and dishes on sale are
// found (the public key can't read anything else).
import type { Config, Context } from '@netlify/edge-functions'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Preview = { title: string; description: string; image: string | null }

async function query(base: string, key: string, path: string) {
  const res = await fetch(`${base}/rest/v1/${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'food' },
    signal: AbortSignal.timeout(2500),
  })
  const rows = res.ok ? await res.json() : []
  return rows[0]
}

async function shopPreview(base: string, key: string, slug: string): Promise<Preview | null> {
  const shop = await query(base, key, `shops?slug=eq.${slug}&status=eq.live&select=name,story,area_label,cuisines,cover_path&limit=1`)
  if (!shop) return null
  const where = [shop.area_label, ...(shop.cuisines ?? [])].filter(Boolean).join(' · ')
  return {
    title: `${shop.name} · BiteBY`,
    description: (shop.story || `Homemade food on BiteBY${where ? ` · ${where}` : ''}. Order online.`).slice(0, 200),
    image: shop.cover_path ? `${base}/storage/v1/object/public/product-images/${shop.cover_path}` : null,
  }
}

async function dishPreview(base: string, key: string, slug: string, id: string): Promise<Preview | null> {
  const dish = await query(base, key,
    `products?id=eq.${id}&status=eq.published&shops.slug=eq.${slug}&select=name,description,price_pence,shops!inner(name,slug,cover_path),product_images(path,sort)&limit=1`)
  if (!dish) return null
  const price = `£${(dish.price_pence / 100).toFixed(2)}`
  const first = [...(dish.product_images ?? [])].sort((a: { sort: number }, b: { sort: number }) => a.sort - b.sort)[0]?.path
  // Some apps can't show WebP previews, so the shop's JPEG cover is preferred over a WebP dish photo.
  const photo = first && !first.endsWith('.webp') ? first : dish.shops.cover_path || first
  return {
    title: `${dish.name} · ${price} · ${dish.shops.name}`,
    description: (dish.description || `Homemade by ${dish.shops.name}. Order on BiteBY.`).slice(0, 200),
    image: photo ? `${base}/storage/v1/object/public/product-images/${photo}` : null,
  }
}

export default async (request: Request, context: Context) => {
  const response = await context.next()
  const [, , slug, kind, id] = new URL(request.url).pathname.split('/')
  const base = Netlify.env.get('VITE_SUPABASE_URL')
  const key = Netlify.env.get('VITE_SUPABASE_ANON_KEY')
  if (!slug || !/^[a-z0-9-]{3,40}$/.test(slug) || !base || !key) return response
  const isDish = kind === 'i' && /^[0-9a-f-]{36}$/.test(id ?? '')
  if (kind && !isDish) return response

  try {
    const preview = isDish ? await dishPreview(base, key, slug, id) : await shopPreview(base, key, slug)
    if (!preview) return response
    const { title, description, image } = preview
    const tags = [
      `<title>${escape(title)}</title>`,
      `<meta name="description" content="${escape(description)}" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="BiteBY" />`,
      `<meta property="og:title" content="${escape(title)}" />`,
      `<meta property="og:description" content="${escape(description)}" />`,
      `<meta property="og:url" content="${escape(request.url)}" />`,
      image ? `<meta property="og:image" content="${escape(image)}" />` : '',
      `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    ].join('\n    ')

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

export const config: Config = { path: ['/s/*', '/s/*/i/*'] }
