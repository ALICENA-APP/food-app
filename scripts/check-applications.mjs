#!/usr/bin/env node
// Checks new cook applications against the Food Standards Agency register
// (api.ratings.food.gov.uk, free, no key) and records the result with
// food.record_application_check(), which adds the rule checks and approves
// green applications. Run by .github/workflows/check-applications.yml.
// Needs SUPABASE_DB_URL. FSA_API can point at a stand-in for tests.
import { spawnSync } from 'node:child_process'

const DB = process.env.SUPABASE_DB_URL
const FSA = process.env.FSA_API ?? 'https://api.ratings.food.gov.uk'
if (!DB) {
  console.log('SUPABASE_DB_URL is not set, skipping')
  process.exit(0)
}

function sql(query, vars = {}) {
  const args = [DB, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1']
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const r = spawnSync('psql', args, { input: query, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

const squash = (s) => (s ?? '').toUpperCase().replace(/\s+/g, '')
const words = (s) => new Set((s ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'kitchen', 'ltd', 'limited', 'food', 'foods'].includes(w)))
// How alike two business names are, 0 to 1.
function likeness(a, b) {
  const x = words(a), y = words(b)
  if (!x.size || !y.size) return 0
  let same = 0
  for (const w of x) if (y.has(w)) same++
  return same / Math.min(x.size, y.size)
}

async function fsa(path) {
  const res = await fetch(FSA + path, { headers: { 'x-api-version': '2', accept: 'application/json' } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`FSA ${res.status} for ${path}`)
  return res.json()
}

const summary = (e, postcode) => ({
  status: 'found',
  fhrs_id: String(e.FHRSID),
  name: e.BusinessName,
  postcode: e.PostCode,
  postcode_match: postcode ? squash(e.PostCode) === postcode : null,
  rating: String(e.RatingValue),
  rating_date: e.RatingDate ? String(e.RatingDate).slice(0, 10) : null,
  authority: e.LocalAuthorityName,
  business_type: e.BusinessType,
})

// Finds the cook on the register: by their FSA link if they gave one, else by
// name near their postcode, else anything at their postcode with a similar name.
async function lookUp(app) {
  if (app.fhrs_id) {
    const e = await fsa(`/Establishments/${encodeURIComponent(app.fhrs_id)}`)
    if (e?.FHRSID) return summary(e, app.postcode)
  }
  if (!app.postcode) return { status: 'not_found', reason: 'no postcode' }
  for (const name of app.names) {
    const r = await fsa(`/Establishments?name=${encodeURIComponent(name)}&address=${encodeURIComponent(app.postcode)}&pageSize=10`)
    const hit = (r?.establishments ?? []).find((e) => squash(e.PostCode) === app.postcode)
    if (hit) return summary(hit, app.postcode)
  }
  const r = await fsa(`/Establishments?address=${encodeURIComponent(app.postcode)}&pageSize=100`)
  const best = (r?.establishments ?? [])
    .filter((e) => squash(e.PostCode) === app.postcode)
    .map((e) => ({ e, score: Math.max(...app.names.map((n) => likeness(n, e.BusinessName))) }))
    .sort((a, b) => b.score - a.score)[0]
  if (best && best.score >= 0.5) return summary(best.e, app.postcode)
  return { status: 'not_found' }
}

const apps = JSON.parse(sql('select food.applications_to_check();') || '[]')
console.log(`${apps.length} application(s) to check`)
for (const app of apps) {
  let result
  try {
    result = await lookUp(app)
  } catch (err) {
    // The register is down or busy: try again on the next run.
    console.log(`  ${app.id}: FSA lookup failed (${err.message}), will retry`)
    continue
  }
  const colour = sql("select food.record_application_check(:'acct'::uuid, :'fsa'::jsonb);", { acct: app.id, fsa: JSON.stringify(result) })
  console.log(`  ${app.id}: ${result.status} -> ${colour}`)
}
