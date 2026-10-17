import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// The 14 main allergens, with short names for chips and warnings.
export const ALLERGENS: { code: string; label: string }[] = [
  { code: 'peanuts', label: 'Peanuts' },
  { code: 'tree_nuts', label: 'Tree nuts' },
  { code: 'milk', label: 'Milk' },
  { code: 'eggs', label: 'Eggs' },
  { code: 'cereals_gluten', label: 'Gluten' },
  { code: 'sesame', label: 'Sesame' },
  { code: 'soya', label: 'Soya' },
  { code: 'fish', label: 'Fish' },
  { code: 'crustaceans', label: 'Crustaceans' },
  { code: 'molluscs', label: 'Molluscs' },
  { code: 'celery', label: 'Celery' },
  { code: 'mustard', label: 'Mustard' },
  { code: 'lupin', label: 'Lupin' },
  { code: 'sulphites', label: 'Sulphites' },
]
export const allergenLabel = (code: string) => ALLERGENS.find((a) => a.code === code)?.label ?? code

// Allergies are health information, so they stay on this phone only and are
// never sent to BiteBY.
export type MyAllergies = { codes: string[]; strict: boolean }
const KEY = 'myAllergies'
const EVENT = 'my-allergies'

function read(): MyAllergies {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (v && Array.isArray(v.codes)) return { codes: v.codes.filter((c: unknown) => typeof c === 'string'), strict: Boolean(v.strict) }
  } catch {
    // storage unavailable
  }
  return { codes: [], strict: false }
}

export function saveMyAllergies(v: MyAllergies) {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new Event(EVENT))
}

export function useMyAllergies() {
  const [value, setValue] = useState<MyAllergies>(read)
  useEffect(() => {
    const update = () => setValue(read())
    window.addEventListener(EVENT, update)
    window.addEventListener('storage', update)
    return () => {
      window.removeEventListener(EVENT, update)
      window.removeEventListener('storage', update)
    }
  }, [])
  return value
}

// For each dish, which of these allergens it contains or may contain. A size
// or option that contains one counts for the whole dish, to be safe.
export type AllergenHits = Record<string, { contains: string[]; may: string[] }>

export function useAllergenHits(productIds: string[], codes: string[]) {
  const [hits, setHits] = useState<AllergenHits | null>(null)
  const ids = [...new Set(productIds)].sort().join(',')
  const wanted = [...codes].sort().join(',')
  useEffect(() => {
    if (!ids || !wanted) return setHits({})
    let cancelled = false
    ;(async () => {
      const list = ids.split(',')
      const out: AllergenHits = {}
      for (let i = 0; i < list.length; i += 100) {
        const { data } = await supabase!.from('product_allergens').select('product_id, allergen_code, presence')
          .in('product_id', list.slice(i, i + 100)).in('allergen_code', wanted.split(',')).in('presence', ['contains', 'may_contain'])
        for (const r of data ?? []) {
          const h = (out[r.product_id] ??= { contains: [], may: [] })
          const bucket = r.presence === 'contains' ? h.contains : h.may
          if (!bucket.includes(r.allergen_code)) bucket.push(r.allergen_code)
        }
      }
      for (const h of Object.values(out)) h.may = h.may.filter((c) => !h.contains.includes(c))
      if (!cancelled) setHits(out)
    })()
    return () => {
      cancelled = true
    }
  }, [ids, wanted])
  return hits
}

// Whether a dish is safe to show under the person's settings.
export function freeFrom(hits: AllergenHits | null, productId: string, strict: boolean) {
  const h = hits?.[productId]
  if (!h) return true
  return h.contains.length === 0 && (!strict || h.may.length === 0)
}

export function warningText(h: { contains: string[]; may: string[] } | undefined) {
  if (!h) return ''
  const parts = []
  if (h.contains.length) parts.push(`contains ${h.contains.map(allergenLabel).join(', ').toLowerCase()}`)
  if (h.may.length) parts.push(`may contain ${h.may.map(allergenLabel).join(', ').toLowerCase()}`)
  return parts.join(' and ')
}
