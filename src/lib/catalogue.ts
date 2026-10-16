import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import type { Shop } from './types'

// A dish as shown on cards around the app, with its shop and first photo.
export type Dish = {
  id: string
  shop_id: string
  name: string
  description: string | null
  price_pence: number
  portion: string | null
  stock_qty: number | null
  dietary: string[]
  category_id: string | null
  collection_ok: boolean
  delivery_ok: boolean
  created_at: string
  shops: Pick<Shop, 'id' | 'name' | 'slug' | 'logo_path' | 'area_label' | 'accepting_orders'>
  product_images: { path: string; sort: number }[]
}

export type Rating = { average: number; reviews: number }

export const DISH_FIELDS =
  'id, shop_id, name, description, price_pence, portion, stock_qty, dietary, category_id, collection_ok, delivery_ok, created_at, ' +
  'shops!inner(id, name, slug, logo_path, area_label, accepting_orders, status), product_images(path, sort)'

// Dishes on sale in live shops. The database only returns what the public may see.
export function dishQuery() {
  return supabase!
    .from('products')
    .select(DISH_FIELDS)
    .eq('status', 'published')
    .eq('shops.status', 'live')
}

export function firstPhoto(d: Pick<Dish, 'product_images'>) {
  return [...(d.product_images ?? [])].sort((a, b) => a.sort - b.sort)[0]?.path ?? null
}

export async function loadRatings(shopIds: string[]): Promise<Record<string, Rating>> {
  if (!shopIds.length) return {}
  const { data } = await supabase!.rpc('shop_ratings', { p_shops: [...new Set(shopIds)] })
  return Object.fromEntries(
    ((data ?? []) as { shop_id: string; average: number; reviews: number }[]).map((r) => [r.shop_id, { average: Number(r.average), reviews: r.reviews }]),
  )
}

export type CategoryRow = { id: string; slug: string; name: string }
let categoriesCache: CategoryRow[] | null = null

export function useCategories() {
  const [rows, setRows] = useState<CategoryRow[]>(categoriesCache ?? [])
  useEffect(() => {
    if (categoriesCache || !supabase) return
    supabase.from('categories').select('id, slug, name').order('sort').then(({ data }) => {
      categoriesCache = data ?? []
      setRows(categoriesCache)
    })
  }, [])
  return rows
}

// Whether each shop offers collection and delivery.
export async function loadShopOptions(shopIds: string[]) {
  if (!shopIds.length) return {} as Record<string, { collection: boolean; delivery: boolean }>
  const { data } = await supabase!.from('shop_settings').select('shop_id, offers_collection, offers_delivery').in('shop_id', [...new Set(shopIds)])
  return Object.fromEntries((data ?? []).map((s) => [s.shop_id, { collection: s.offers_collection, delivery: s.offers_delivery }]))
}
