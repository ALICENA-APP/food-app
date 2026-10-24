// Makes the key pair for phone notifications once, and keeps it in the
// database's private ops schema (never in this public repo). Run by the
// "Database migrations" job; does nothing if the keys already exist.
import { execFileSync } from 'node:child_process'
import { createECDH } from 'node:crypto'

const db = process.env.SUPABASE_DB_URL
if (!db) throw new Error('SUPABASE_DB_URL is not set')
const psql = (sql, input) => execFileSync('psql', [db, '-v', 'ON_ERROR_STOP=1', '-X', '-qAt', '-c', sql], { input, encoding: 'utf8' }).trim()

if (psql("select count(*) from ops.push_keys") !== '0') {
  console.log('push keys already set')
} else {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const pub = ecdh.getPublicKey().toString('base64url')
  const priv = ecdh.getPrivateKey().toString('base64url')
  if (!/^[A-Za-z0-9_-]+$/.test(pub + priv)) throw new Error('unexpected key format')
  psql(`insert into ops.push_keys (id, public_key, private_key) values (1, '${pub}', '${priv}') on conflict do nothing`)
  console.log('push keys created')
}
