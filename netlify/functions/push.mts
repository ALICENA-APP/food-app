// Sends phone notifications. The database calls this for every new alert
// (food.push_alert) with the alert, the person's phones and the private key.
// The key is checked against the public key the app hands out, so nobody
// else can use this to send anything.
import { createECDH } from 'node:crypto'
import webpush from 'web-push'

type Sub = { endpoint: string; p256dh: string; auth: string }
type Body = { key?: string; subs?: Sub[]; title?: string; body?: string | null; link?: string; tag?: string }

// Only the browsers' own push services, so this can't be pointed anywhere else.
const PUSH_HOSTS = /^https:\/\/([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)\//

let publicKey: string | null = null

async function rpc(name: string, args: object) {
  const base = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!base || !key) throw new Error('Supabase settings missing')
  const res = await fetch(`${base}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', 'content-profile': 'food' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`${name}: ${res.status}`)
  return res.status === 204 ? null : res.json()
}

const toUrlB64 = (b: Buffer) => b.toString('base64url')

export default async (request: Request) => {
  if (request.method !== 'POST') return new Response('Not found', { status: 404 })
  let data: Body
  try {
    data = await request.json()
  } catch {
    return new Response('Bad request', { status: 400 })
  }
  const { key, subs } = data
  if (!key || !Array.isArray(subs) || !subs.length) return new Response('Bad request', { status: 400 })

  publicKey ??= (await rpc('push_public_key', {})) as string | null
  let derived = ''
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(key, 'base64url'))
    derived = toUrlB64(ecdh.getPublicKey())
  } catch {
    // not a key
  }
  if (!publicKey || derived !== publicKey) return new Response('Forbidden', { status: 403 })

  webpush.setVapidDetails(process.env.URL || 'https://food.beastcase.net', publicKey, key)
  const payload = JSON.stringify({
    title: String(data.title ?? 'BiteBY').slice(0, 120),
    body: data.body ? String(data.body).slice(0, 300) : '',
    link: typeof data.link === 'string' && data.link.startsWith('/') ? data.link : '/alerts',
    tag: data.tag ? String(data.tag).slice(0, 40) : undefined,
  })

  const gone: string[] = []
  await Promise.all(subs.slice(0, 10).filter((s) => PUSH_HOSTS.test(s.endpoint)).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' })
    } catch (e) {
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) gone.push(s.endpoint)
    }
  }))
  if (gone.length) await rpc('forget_push_endpoints', { p_endpoints: gone }).catch(() => {})
  return Response.json({ sent: subs.length - gone.length, gone: gone.length })
}
