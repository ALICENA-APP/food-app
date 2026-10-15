import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const isConfigured = Boolean(url && anonKey)

// All Food App tables live in the `food` schema, separate from the other app
// sharing this Supabase project.
export const supabase = isConfigured
  ? createClient(url!, anonKey!, { db: { schema: 'food' } })
  : null
