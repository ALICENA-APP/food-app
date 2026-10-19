import type { StyleSpecification } from 'maplibre-gl'

// The BiteBY map: OpenFreeMap's free vector tiles (OpenStreetMap data, no key
// needed), drawn in the app's own colours instead of a real-world look.
const C = {
  land: '#fffdf7',
  urban: '#fff7e0',
  park: '#e6f6ec',
  wood: '#d9f0e1',
  water: '#d6ecf5',
  building: '#fff1c7',
  minor: '#ffffff',
  minorEdge: '#f3e3b3',
  major: '#ffe08a',
  majorEdge: '#ffc72c',
  motorway: '#ffc72c',
  rail: '#e8d9ae',
  label: '#5f5f5f',
  place: '#111111',
  halo: '#fffdf7',
}

const font = ['Noto Sans Regular']
const bold = ['Noto Sans Bold']

const width = (stops: [number, number][]) => ['interpolate', ['exponential', 1.5], ['zoom'], ...stops.flat()] as unknown as number

export function biteByMapStyle(dark = false): StyleSpecification {
  const c = dark
    ? { ...C, land: '#1d1d1d', urban: '#232017', park: '#15301f', wood: '#15301f', water: '#16262d', building: '#2a2412', minor: '#2f2f2f', minorEdge: '#262626', major: '#5a4a1c', majorEdge: '#8a6d1a', motorway: '#b8901f', rail: '#3a3428', label: '#a9a9a9', place: '#f2f2f2', halo: '#1d1d1d' }
    : C
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: { omt: { type: 'vector', url: 'https://tiles.openfreemap.org/planet', attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' } },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': c.land } },
      { id: 'urban', type: 'fill', source: 'omt', 'source-layer': 'landuse', filter: ['in', ['get', 'class'], ['literal', ['residential', 'suburb', 'neighbourhood', 'commercial', 'retail', 'industrial']]], paint: { 'fill-color': c.urban } },
      { id: 'wood', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['wood', 'forest']]], paint: { 'fill-color': c.wood } },
      { id: 'grass', type: 'fill', source: 'omt', 'source-layer': 'landcover', filter: ['in', ['get', 'class'], ['literal', ['grass', 'farmland', 'scrub']]], paint: { 'fill-color': c.park, 'fill-opacity': 0.7 } },
      { id: 'park', type: 'fill', source: 'omt', 'source-layer': 'park', paint: { 'fill-color': c.park } },
      { id: 'water', type: 'fill', source: 'omt', 'source-layer': 'water', paint: { 'fill-color': c.water } },
      { id: 'waterway', type: 'line', source: 'omt', 'source-layer': 'waterway', paint: { 'line-color': c.water, 'line-width': width([[8, 1], [14, 4]]) } },
      { id: 'building', type: 'fill', source: 'omt', 'source-layer': 'building', minzoom: 13, paint: { 'fill-color': c.building } },
      { id: 'rail', type: 'line', source: 'omt', 'source-layer': 'transportation', filter: ['==', ['get', 'class'], 'rail'], paint: { 'line-color': c.rail, 'line-width': width([[8, 0.5], [14, 2]]) } },
      { id: 'minor-edge', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 12, filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.minorEdge, 'line-width': width([[12, 1.5], [15, 8]]) } },
      { id: 'minor', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 11, filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.minor, 'line-width': width([[11, 0.5], [15, 6]]) } },
      { id: 'major-edge', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8, filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.majorEdge, 'line-width': width([[8, 1], [15, 11]]) } },
      { id: 'major', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 8, filter: ['in', ['get', 'class'], ['literal', ['primary', 'secondary', 'trunk']]], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.major, 'line-width': width([[8, 0.5], [15, 8]]) } },
      { id: 'motorway', type: 'line', source: 'omt', 'source-layer': 'transportation', minzoom: 5, filter: ['==', ['get', 'class'], 'motorway'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.motorway, 'line-width': width([[5, 0.6], [15, 10]]) } },
      { id: 'road-names', type: 'symbol', source: 'omt', 'source-layer': 'transportation_name', minzoom: 13, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 11 }, paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.5 } },
      { id: 'small-places', type: 'symbol', source: 'omt', 'source-layer': 'place', minzoom: 11, filter: ['in', ['get', 'class'], ['literal', ['suburb', 'neighbourhood', 'village', 'hamlet', 'quarter']]], layout: { 'text-field': ['get', 'name'], 'text-font': font, 'text-size': 12 }, paint: { 'text-color': c.label, 'text-halo-color': c.halo, 'text-halo-width': 1.5 } },
      { id: 'towns', type: 'symbol', source: 'omt', 'source-layer': 'place', filter: ['in', ['get', 'class'], ['literal', ['city', 'town']]], layout: { 'text-field': ['get', 'name'], 'text-font': bold, 'text-size': width([[5, 11], [12, 16]]) }, paint: { 'text-color': c.place, 'text-halo-color': c.halo, 'text-halo-width': 2 } },
    ],
  }
}
