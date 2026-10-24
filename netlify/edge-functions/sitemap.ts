// The list of pages Google should know about: every live shop and dish,
// and a "Homemade food in <town>" page for each town with a real cook.
// Demo and test shops are left out.
import type { Config } from '@netlify/edge-functions'

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export default async (request: Request) => {
  const origin = new URL(request.url).origin
  const base = Netlify.env.get('VITE_SUPABASE_URL')
  const key = Netlify.env.get('VITE_SUPABASE_ANON_KEY')
  const urls: { loc: string; lastmod?: string }[] = ['/', '/explore', '/sell', '/fees'].map((p) => ({ loc: origin + p }))
  if (base && key) {
    const get = async (path: string, init?: RequestInit) => {
      try {
        const res = await fetch(`${base}/rest/v1/${path}`, {
          ...init,
          headers: { apikey: key, authorization: `Bearer ${key}`, 'accept-profile': 'food', 'content-profile': 'food', 'content-type': 'application/json' },
          signal: AbortSignal.timeout(4000),
        })
        return res.ok ? await res.json() : []
      } catch {
        return []
      }
    }
    const [shops, dishes, towns] = await Promise.all([
      get('shops?status=eq.live&is_demo=eq.false&is_test=eq.false&select=slug,updated_at&limit=5000'),
      get('products?status=eq.published&shops.status=eq.live&shops.is_demo=eq.false&shops.is_test=eq.false&select=id,updated_at,shops!inner(slug)&limit=20000'),
      get('rpc/towns', { method: 'POST', body: '{}' }),
    ])
    for (const s of shops) urls.push({ loc: `${origin}/s/${s.slug}`, lastmod: s.updated_at })
    for (const d of dishes) urls.push({ loc: `${origin}/s/${d.shops.slug}/i/${d.id}`, lastmod: d.updated_at })
    for (const t of towns) if (t.real_shops > 0) urls.push({ loc: `${origin}/near/${t.slug}` })
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${escape(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`
  return new Response(body, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } })
}

export const config: Config = { path: '/sitemap.xml' }
