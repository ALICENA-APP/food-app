import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from './supabase'
import { navigate } from './router'
import { photoUrl } from './images'

export type MapShop = { id: string; name: string; slug: string; logo_path: string | null; area_label: string | null }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// Cooks on a map. Spots are rounded to about a kilometre, so homes are never shown.
export default function ShopMap({ shops, me }: { shops: MapShop[]; me: { lat: number; lng: number } | null }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const [spots, setSpots] = useState<Record<string, [number, number]> | null>(null)

  useEffect(() => {
    supabase!.rpc('shops_map').then(({ data }) => {
      setSpots(Object.fromEntries(((data ?? []) as { shop_id: string; lat: number; lng: number }[]).map((r) => [r.shop_id, [r.lat, r.lng]])))
    })
  }, [])

  useEffect(() => {
    if (!el.current || map.current) return
    map.current = L.map(el.current, { zoomControl: true, attributionControl: true }).setView([54.2, -2.6], 5)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 15,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map.current)
    layer.current = L.layerGroup().addTo(map.current)
    // Popups link inside the app without a full page load.
    el.current.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('a[data-to]')
      if (a) {
        e.preventDefault()
        navigate(a.getAttribute('data-to')!)
      }
    })
    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    if (!map.current || !layer.current || !spots) return
    layer.current.clearLayers()
    const points: L.LatLngExpression[] = []
    // Shops in the same rounded spot are fanned out a little so all show.
    const seen: Record<string, number> = {}
    for (const s of shops) {
      const spot = spots[s.id]
      if (!spot) continue
      const k = spot.join(',')
      const n = (seen[k] = (seen[k] ?? -1) + 1)
      const at: [number, number] = [spot[0] + n * 0.0025, spot[1] + n * 0.004]
      points.push(at)
      const logo = photoUrl(s.logo_path)
      const icon = L.divIcon({
        className: 'map-pin',
        html: logo ? `<img src="${esc(logo)}" alt="">` : `<span>${esc(s.name.slice(0, 1))}</span>`,
        iconSize: [40, 40],
        iconAnchor: [20, 20],
      })
      L.marker(at, { icon, title: s.name }).addTo(layer.current)
        .bindPopup(`<strong>${esc(s.name)}</strong><br><span>${esc(s.area_label ?? '')}</span><br><a href="/s/${esc(s.slug)}" data-to="/s/${esc(s.slug)}">See menu</a>`)
    }
    if (me) {
      L.circleMarker([me.lat, me.lng], { radius: 7, color: '#111', fillColor: '#FFC72C', fillOpacity: 1, weight: 2 }).addTo(layer.current).bindPopup('You')
      map.current.setView([me.lat, me.lng], 12)
    } else if (points.length) {
      map.current.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 12 })
    }
  }, [shops, spots, me])

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div ref={el} className="shop-map" />
      <p className="muted tiny">Pins show the rough area only, never a cook’s home.</p>
    </div>
  )
}
