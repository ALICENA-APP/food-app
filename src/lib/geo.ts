import { formatPostcode, postcodeDistrict, type Point } from './postcode'

// Where a UK postcode is, using the free postcodes.io service. Falls back to
// the middle of the postcode area (e.g. E3) if the full postcode isn't found.
export async function locatePostcode(postcode: string): Promise<Point | null> {
  const full = formatPostcode(postcode)
  if (!full) return null
  const tries = [`https://api.postcodes.io/postcodes/${encodeURIComponent(full)}`, `https://api.postcodes.io/outcodes/${encodeURIComponent(postcodeDistrict(full))}`]
  for (const url of tries) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      if (!res.ok) continue
      const { result } = await res.json()
      if (result?.latitude && result?.longitude) return { lat: result.latitude, lng: result.longitude }
    } catch {
      // offline or service down
    }
  }
  return null
}
