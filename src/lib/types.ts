export type SellerStatus =
  | 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected'
  | 'reverification_required' | 'suspended' | 'removed'

export type SellerAccount = {
  id: string
  status: SellerStatus
  legal_name: string | null
  trading_name: string | null
  business_type: string | null
  charges_enabled: boolean
  terms_accepted_at: string | null
  status_note: string | null
}

export type Verification = {
  id: string
  seller_account_id: string
  kind: 'food_registration' | 'hygiene_rating' | 'allergen_declaration' | 'insurance'
  status: 'pending' | 'accepted' | 'rejected' | 'expired'
  authority: string | null
  reference: string | null
  registered_on: string | null
  notes: string | null
}

export type Shop = {
  id: string
  seller_account_id: string
  slug: string
  name: string
  story: string | null
  logo_path: string | null
  cover_path: string | null
  area_label: string | null
  cuisines: string[]
  status: 'draft' | 'live' | 'paused' | 'suspended'
  accepting_orders: boolean
}

export type ShopSettings = {
  shop_id: string
  offers_collection: boolean
  offers_delivery: boolean
  min_order_pence: number
}

export type ShopPrivate = {
  shop_id: string
  address_line1: string | null
  address_line2: string | null
  city: string | null
  postcode: string | null
  collection_instructions: string | null
  contact_phone: string | null
}

export type Presence = 'contains' | 'may_contain' | 'not_present'

export type Product = {
  id: string
  shop_id: string
  name: string
  description: string | null
  category_id: string | null
  price_pence: number
  portion: string | null
  ingredients: string | null
  may_contain_notes: string | null
  collection_ok: boolean
  delivery_ok: boolean
  dietary: string[]
  status: 'draft' | 'published' | 'archived'
  allergens_confirmed_at: string | null
}

export type Allergen = { code: string; name: string }
export type Category = { id: string; name: string; slug?: string }

// Optional labels a seller can put on an item.
export const DIETARY = [
  { code: 'vegetarian', name: 'Vegetarian' },
  { code: 'vegan', name: 'Vegan' },
  { code: 'halal', name: 'Halal' },
  { code: 'spicy', name: 'Spicy' },
]
export const dietaryName = (code: string) => DIETARY.find((d) => d.code === code)?.name ?? code

export const TERMS_VERSION = '2026-10-v1'

export function pounds(pence: number) {
  return `£${(pence / 100).toFixed(2)}`
}
