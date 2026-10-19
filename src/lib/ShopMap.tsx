import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { supabase } from './supabase'
import { navigate } from './router'
import { photoUrl } from './images'
import { biteByMapStyle } from './mapStyle'

export type MapShop = { id: string; name: string; slug: string; logo_path: string | null; area_label: string | null }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// A 700 m circle in screen pixels at each zoom (around UK latitudes).
const AREA = ['interpolate', ['exponential', 2], ['zoom'], 5, 0.23, 13, 58.9] as unknown as number

// Cooks on a map. Spots are rounded to about a kilometre, so homes are never shown.
export default function ShopMap({ shops, me }: { shops: MapShop[]; me: { lat: number; lng: number } | null }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const markers = useRef<maplibregl.Marker[]>([])
  const [ready, setReady] = useState(false)
  const [spots, setSpots] = useState<Record<string, [number, number]> | null>(null)

  useEffect(() => {
    supabase!.rpc('shops_map').then(({ data }) => {
      setSpots(Object.fromEntries(((data ?? []) as { shop_id: string; lat: number; lng: number }[]).map((r) => [r.shop_id, [r.lat, r.lng]])))
    })
  }, [])

  useEffect(() => {
    if (!el.current || map.current) return
    const dark = document.documentElement.dataset.theme === 'dark'
    const m = new maplibregl.Map({ container: el.current, style: biteByMapStyle(dark), center: [-2.6, 54.2], zoom: 4.5, maxZoom: 13, attributionControl: { compact: false } })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left')
    // style.load comes before the tiles, so pins still show if tiles are slow.
    m.once('style.load', () => {
      m.addSource('areas', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      m.addLayer({ id: 'areas', type: 'circle', source: 'areas', paint: { 'circle-radius': AREA, 'circle-color': '#ffc72c', 'circle-opacity': 0.25 } })
      setReady(true)
    })
    map.current = m
    // Popups link inside the app without a full page load.
    el.current.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-to]')
      if (a) {
        e.preventDefault()
        navigate(a.getAttribute('data-to')!)
      }
    })
    return () => {
      m.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const m = map.current
    if (!m || !ready || !spots) return
    markers.current.forEach((x) => x.remove())
    markers.current = []
    const points: [number, number][] = []
    // Shops in the same rounded spot are fanned out a little so all show.
    const seen: Record<string, number> = {}
    for (const s of shops) {
      const spot = spots[s.id]
      if (!spot) continue
      const k = spot.join(',')
      const n = (seen[k] = (seen[k] ?? -1) + 1)
      const at: [number, number] = [spot[1] + n * 0.004, spot[0] + n * 0.0025]
      points.push(at)
      const logo = photoUrl(s.logo_path)
      const pin = document.createElement('div')
      pin.className = 'map-pin'
      pin.innerHTML = logo ? `<img src="${esc(logo)}" alt="">` : `<span>${esc(s.name.slice(0, 1))}</span>`
      pin.title = s.name
      const popup = new maplibregl.Popup({ offset: 22, closeButton: false })
        .setHTML(`<strong>${esc(s.name)}</strong><br><span>${esc(s.area_label ?? '')}</span><br><a href="/s/${esc(s.slug)}" data-to="/s/${esc(s.slug)}">See menu</a>`)
      markers.current.push(new maplibregl.Marker({ element: pin }).setLngLat(at).setPopup(popup).addTo(m))
    }
    ;(m.getSource('areas') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: points.map((p) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })) })
    if (me) {
      const dot = document.createElement('div')
      dot.className = 'map-me'
      markers.current.push(new maplibregl.Marker({ element: dot }).setLngLat([me.lng, me.lat]).setPopup(new maplibregl.Popup({ offset: 10, closeButton: false }).setText('You')).addTo(m))
      m.jumpTo({ center: [me.lng, me.lat], zoom: 11.5 })
    } else if (points.length) {
      const b = new maplibregl.LngLatBounds(points[0], points[0])
      points.forEach((p) => b.extend(p))
      m.fitBounds(b, { padding: 40, maxZoom: 11.5, duration: 0 })
    }
  }, [shops, spots, me, ready])

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div ref={el} className="shop-map" />
      <p className="muted tiny">Pins show the rough area only, never a cook’s home.</p>
    </div>
  )
}
