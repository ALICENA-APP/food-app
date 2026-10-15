import { supabase } from './supabase'

const BUCKET = 'product-images'
const MAX_BYTES = 250 * 1024 // bucket allows 300 KB; stay under it

// Public web address of a photo in the product-images bucket.
export function photoUrl(path: string | null | undefined) {
  if (!path || !supabase) return null
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl
}

// Shrinks a phone photo to a small WebP (or JPEG where WebP isn't supported)
// so it fits the free storage: longest side `maxSide`, quality stepped down
// until it's under 250 KB.
export async function shrinkImage(file: File, maxSide = 1200, types = ['image/webp', 'image/jpeg']): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  for (const type of types) {
    for (let q = 0.82; q >= 0.4; q -= 0.12) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, q))
      if (blob && blob.type === type && blob.size <= MAX_BYTES) return blob
    }
  }
  throw new Error('This photo is too large. Try a smaller one.')
}

// Uploads a shrunk photo under the shop's folder and returns its path.
// `jpeg` is for photos used in link previews, which some apps can't show as WebP.
export async function uploadPhoto(shopId: string, file: File, maxSide?: number, jpeg = false) {
  const blob = await shrinkImage(file, maxSide, jpeg ? ['image/jpeg'] : undefined)
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
  const path = `${shopId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase!.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000' })
  if (error) throw new Error(error.message)
  return path
}

export async function deletePhoto(path: string) {
  await supabase!.storage.from(BUCKET).remove([path])
}
