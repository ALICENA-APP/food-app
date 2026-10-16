// Adds the shop's name, story and cover photo to /s/<slug> pages so links
// shared on WhatsApp, Facebook, etc. show a proper preview card. Only live
// shops are found (the public key can't read anything else).
import type { Config, Context } from '@netlify/edge-functions'

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export default async (request: Request, context: Context) => {
  const response = await context.next()
  const slug = new URL(request.url).pathname.split('/')[2]
  const base = Netlify.env.get('VITE_SUPABASE_URL')
  const key = Netlify.env.get('VITE_SUPABASE_ANON_KEY')
  if (!slug || !/^[a-z0-9-]{3,40}$/.test(slug) || !base || !key) return response

  try {
    const api = `${base}/rest/v1/shops?slug=eq.${slug}&status=eq.live&select=name,story,area_label,cuisines,cover_path&limit=1`
    const res = await fetch(api, {
      headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'food' },
      signal: AbortSignal.timeout(2500),
    })
    const [shop] = res.ok ? await res.json() : []
    if (!shop) return response

    const title = `${shop.name} · BiteBY`
    const where = [shop.area_label, ...(shop.cuisines ?? [])].filter(Boolean).join(' · ')
    const description = (shop.story || `Homemade food on BiteBY${where ? ` · ${where}` : ''}. Order online.`).slice(0, 200)
    const image = shop.cover_path ? `${base}/storage/v1/object/public/product-images/${shop.cover_path}` : null
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

export const config: Config = { path: '/s/*' }
